import { Tn5250Error, type AidKey, type ScreenSnapshot } from "@as400web/core";
import { SessionManager, type OpenOptions } from "./session-manager.js";
import { ProfileStore } from "./profiles.js";
import { withAudit } from "./audit.js";
import type { WsClientMessage, WsServerMessage } from "./ws-messages.js";

export interface WsHandlerDeps {
  sessions: SessionManager;
  profiles: ProfileStore;
}

/** WSContext の最小インターフェース（@hono/node-server の WSContext / テストのモック双方に適合） */
export interface WsSender {
  send(data: string): void;
  close(): void;
}

/**
 * 1 WebSocket 接続 = 1 セッションの状態機械（spec「Web 向けプロトコル」）。
 * open/key/jobinfo/close を処理し、session の screen イベントを push する。切断でセッションを破棄する。
 */
export class WsConnection {
  private sessionId: string | undefined;
  private detachScreen: (() => void) | undefined;

  constructor(
    private readonly deps: WsHandlerDeps,
    private readonly ws: WsSender
  ) {}

  async handle(raw: string): Promise<void> {
    let msg: WsClientMessage;
    try {
      msg = JSON.parse(raw) as WsClientMessage;
    } catch {
      return this.sendError("PROTOCOL_ERROR", "invalid JSON", false);
    }
    try {
      switch (msg.type) {
        case "open":
          return await this.onOpen(msg);
        case "key":
          return await this.onKey(msg);
        case "jobinfo":
          return await this.onJobInfo(msg);
        case "gui-select":
          return await this.onGuiSelect(msg);
        case "gui-submit":
          return await this.onGuiSubmit(msg);
        case "close":
          return this.dispose("closed by client");
        default:
          return this.sendError("PROTOCOL_ERROR", `unknown message type`, false);
      }
    } catch (err) {
      const code = err instanceof Tn5250Error ? err.code : "INTERNAL_ERROR";
      const fatal = code === "SESSION_CLOSED" || code === "CONNECT_FAILED";
      this.sendError(code, err instanceof Error ? err.message : String(err), fatal);
    }
  }

  /** WebSocket 切断時に呼ぶ（セッションを破棄） */
  onSocketClose(): void {
    this.dispose("websocket closed");
  }

  private async onOpen(msg: WsClientMessage & { type: "open" }): Promise<void> {
    if (this.sessionId) throw new Tn5250Error("PROTOCOL_ERROR", "session already open on this connection");
    await withAudit({ op: "ws_open" }, async () => {
      const opts: OpenOptions = msg.profile
        ? { ...this.deps.profiles.resolveConnectOptions(msg.profile), origin: msg.profile }
        : buildDirect(msg);
      if (msg.readOnly) opts.readOnly = true;
      const entry = await this.deps.sessions.open(opts);
      this.sessionId = entry.id;
      // ホスト発の画面更新を push
      const onScreen = (screen: ScreenSnapshot): void => this.send({ type: "screen", screen });
      entry.session.on("screen", onScreen);
      entry.session.on("closed", (reason) => {
        this.send({ type: "closed", reason });
        this.detachScreen?.();
      });
      this.detachScreen = () => entry.session.off("screen", onScreen);
      this.send({
        type: "opened",
        sessionId: entry.id,
        screen: entry.session.snapshot(),
        ccsid: opts.ccsid ?? 37
      });
    });
  }

  private async onKey(msg: WsClientMessage & { type: "key" }): Promise<void> {
    const id = this.requireSession();
    await withAudit({ op: "ws_key", sessionId: id, key: msg.key }, async () => {
      const entry = this.deps.sessions.assertKeyAllowed(id, msg.key as AidKey);
      if (msg.fields && msg.fields.length > 0) {
        this.deps.sessions.assertWritable(id);
        for (const f of msg.fields) {
          entry.session.setField(typeof f.field === "number" ? { index: f.field } : f.field, f.value);
        }
      }
      // 応答画面は session の screen イベントで push される
      await entry.session.sendAid(msg.key as AidKey, msg.cursor ? { cursor: msg.cursor } : {});
    });
  }

  private async onGuiSelect(msg: WsClientMessage & { type: "gui-select" }): Promise<void> {
    const id = this.requireSession();
    await withAudit({ op: "ws_gui_select", sessionId: id }, async () => {
      const entry = this.deps.sessions.assertWritable(id);
      const ok = entry.session.selectGuiChoice(msg.fieldId, msg.choiceIndex, msg.selected ?? true);
      if (!ok) throw new Tn5250Error("FIELD_TYPE", `選択できません（fieldId=${msg.fieldId}）`);
      // 更新画面は session の screen イベントで push される
    });
  }

  private async onGuiSubmit(msg: WsClientMessage & { type: "gui-submit" }): Promise<void> {
    const id = this.requireSession();
    await withAudit({ op: "ws_gui_submit", sessionId: id }, async () => {
      const entry = this.deps.sessions.assertWritable(id);
      const opts: { key?: AidKey; cursor?: { row: number; col: number } } = {};
      if (msg.key) opts.key = msg.key as AidKey;
      if (msg.cursor) opts.cursor = msg.cursor;
      await entry.session.submitGuiSelection(msg.fieldId, opts);
    });
  }

  private async onJobInfo(msg: WsClientMessage & { type: "jobinfo" }): Promise<void> {
    const id = this.requireSession();
    await withAudit({ op: "ws_jobinfo", sessionId: id }, async () => {
      const entry = this.deps.sessions.assertWritable(id);
      const job = await entry.session.fetchJobInfo(msg.refresh ?? false);
      this.send({ type: "jobinfo", job, cached: false });
    });
  }

  private requireSession(): string {
    if (!this.sessionId) throw new Tn5250Error("SESSION_NOT_FOUND", "no session opened on this connection");
    return this.sessionId;
  }

  private dispose(reason: string): void {
    this.detachScreen?.();
    this.detachScreen = undefined;
    if (this.sessionId) {
      void this.deps.sessions.close(this.sessionId).catch(() => {});
      this.sessionId = undefined;
    }
    this.send({ type: "closed", reason });
  }

  private send(msg: WsServerMessage): void {
    this.ws.send(JSON.stringify(msg));
  }

  private sendError(code: string, message: string, fatal: boolean): void {
    this.send({ type: "error", code, message, fatal });
  }
}

function buildDirect(msg: {
  host?: string;
  port?: number;
  ccsid?: number;
  screenSize?: "24x80" | "27x132";
  deviceName?: string;
  enhanced?: boolean;
  tls?: boolean;
  user?: string;
  password?: string;
}): OpenOptions {
  if (!msg.host) throw new Tn5250Error("CONNECT_FAILED", "host or profile required");
  const o: OpenOptions = { host: msg.host, origin: "direct" };
  if (msg.port !== undefined) o.port = msg.port;
  if (msg.ccsid !== undefined) o.ccsid = msg.ccsid;
  if (msg.screenSize !== undefined) o.screenSize = msg.screenSize;
  if (msg.deviceName !== undefined) o.deviceName = msg.deviceName;
  if (msg.enhanced !== undefined) o.enhanced = msg.enhanced;
  if (msg.tls === true) o.tls = true;
  if (msg.user !== undefined) o.user = msg.user;
  if (msg.password !== undefined) o.password = msg.password;
  return o;
}
