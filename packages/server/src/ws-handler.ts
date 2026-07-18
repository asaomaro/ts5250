import { Tn5250Error, childLog, type AidKey, type ConnectOptions, type ScreenSnapshot } from "@as400web/core";
import { SessionManager, type OpenOptions } from "./session-manager.js";
import type { AuthUser } from "./auth.js";
import { ProfileStore } from "./profiles.js";
import type { ConnectionStore } from "./connection-store.js";
import { withAudit } from "./audit.js";
import type { WsClientMessage, WsServerMessage } from "./ws-messages.js";

const wsLog = childLog({ component: "ws-handler" });

export interface WsHandlerDeps {
  sessions: SessionManager;
  profiles: ProfileStore;
  /** ユーザー接続設定ストア（保存済み接続の ID 参照解決）。未指定なら connection 参照は不可 */
  connections?: ConnectionStore;
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
  private detachReport: (() => void) | undefined;

  constructor(
    private readonly deps: WsHandlerDeps,
    private readonly ws: WsSender,
    private readonly user?: AuthUser
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
        case "printer-output":
          return await this.onPrinterOutput(msg);
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
    if (msg.kind === "printer") return this.onOpenPrinter(msg);
    await withAudit({ op: "ws_open" }, async () => {
      const opts: OpenOptions = msg.connection
        ? { ...this.resolveConnection(msg.connection), origin: msg.connection }
        : msg.profile
          ? {
              ...this.deps.profiles.resolveConnectOptions(msg.profile, (m) => wsLog.warn(m)),
              origin: msg.profile
            }
          : buildDirect(msg);
      if (msg.readOnly) opts.readOnly = true;
      if (this.user) opts.owner = this.user.username;
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

  private async onOpenPrinter(msg: WsClientMessage & { type: "open" }): Promise<void> {
    await withAudit({ op: "ws_open_printer" }, async () => {
      const opts: Parameters<SessionManager["openPrinter"]>[0] = {
        origin: msg.connection ?? msg.profile ?? "direct"
      };
      if (msg.connection) {
        // 保存済み接続由来: 接続情報＋復号資格情報を解決（printer 出力設定は持たない＝信頼設定は profiles 限定）
        const co = this.resolveConnection(msg.connection);
        if (co.host !== undefined) opts.host = co.host;
        if (co.port !== undefined) opts.port = co.port;
        if (co.ccsid !== undefined) opts.ccsid = co.ccsid;
        if (co.deviceName !== undefined) opts.deviceName = co.deviceName;
        if (co.tls !== undefined) opts.tls = co.tls;
        if (co.user !== undefined) opts.user = co.user;
        if (co.password !== undefined) opts.password = co.password;
      } else if (msg.profile) {
        // プロファイル由来: 接続情報＋PDF 自動蓄積/印刷（信頼設定）を解決する
        const co = this.deps.profiles.resolveConnectOptions(msg.profile, (m) => wsLog.warn(m));
        if (co.host !== undefined) opts.host = co.host;
        if (co.port !== undefined) opts.port = co.port;
        if (co.ccsid !== undefined) opts.ccsid = co.ccsid;
        if (co.deviceName !== undefined) opts.deviceName = co.deviceName;
        if (co.tls !== undefined) opts.tls = co.tls;
        if (co.user !== undefined) opts.user = co.user;
        if (co.password !== undefined) opts.password = co.password;
        const output = this.deps.profiles.resolvePrinterOutput(msg.profile);
        if (output) opts.output = output; // 自動蓄積/印刷はプロファイルにあるときだけ
      } else {
        // 直接接続（ブラウザ指定）: 出力設定は受け付けない（任意パス書込・任意コマンド実行の防止）
        if (msg.host !== undefined) opts.host = msg.host;
        if (msg.port !== undefined) opts.port = msg.port;
        if (msg.ccsid !== undefined) opts.ccsid = msg.ccsid;
        if (msg.deviceName !== undefined) opts.deviceName = msg.deviceName;
        if (msg.tls === true) opts.tls = true;
        if (msg.user !== undefined) opts.user = msg.user;
        if (msg.password !== undefined) opts.password = msg.password;
      }
      if (this.user) opts.owner = this.user.username;
      const entry = await this.deps.sessions.openPrinter(opts);
      this.sessionId = entry.id;
      const onReport = (r: { id: string; pages: { rows: number; cols: number; lines: string[] }[] }): void =>
        this.send({ type: "report", sessionId: entry.id, report: { id: r.id, pages: r.pages } });
      entry.session.on("report", onReport);
      entry.session.on("closed", (reason) => {
        this.send({ type: "closed", reason });
        this.detachReport?.();
      });
      this.detachReport = () => {
        entry.session.off("report", onReport);
        delete entry.onOutputWarn; // 切断でフックを解除（リーク防止）
        delete entry.onOutputStatus;
      };
      // 自動出力の失敗を UI へ push（サーバーログ・履歴は session-manager 側で保持）
      entry.onOutputWarn = (w) =>
        this.send({ type: "printer-warn", sessionId: entry.id, at: w.at, message: w.message });
      // 自動出力の結果（成功も含む）を UI へ push
      entry.onOutputStatus = (s) => this.send({ type: "printer-output-result", sessionId: entry.id, status: s });
      this.send({
        type: "printer-opened",
        sessionId: entry.id,
        startupCode: entry.session.startupCode,
        hasOutput: entry.output !== undefined,
        outputEnabled: entry.outputEnabled,
        outputWarnings: entry.outputWarnings,
        outputStatuses: entry.outputStatuses
      });
    });
  }

  /** 自動出力（PDF 保存・自動印刷）の有効/無効を切り替える */
  private async onPrinterOutput(msg: WsClientMessage & { type: "printer-output" }): Promise<void> {
    const id = this.requireSession();
    await withAudit({ op: "ws_printer_output", sessionId: id }, async () => {
      const entry = this.deps.sessions.setPrinterOutputEnabled(id, msg.enabled, this.user);
      this.send({ type: "printer-output-state", sessionId: id, enabled: entry.outputEnabled });
    });
  }

  /** 保存済み接続 ID を ConnectOptions に解決する（assertOwner・復号は store 内）。未配線なら明示エラー */
  private resolveConnection(id: string): ConnectOptions {
    if (!this.deps.connections) throw new Tn5250Error("CONFIG_ERROR", "connection store not configured");
    return this.deps.connections.resolveConnectOptions(id, this.user, (m) => wsLog.warn(m));
  }

  private async onKey(msg: WsClientMessage & { type: "key" }): Promise<void> {
    const id = this.requireSession();
    await withAudit({ op: "ws_key", sessionId: id, key: msg.key }, async () => {
      const entry = this.deps.sessions.assertKeyAllowed(id, msg.key as AidKey, this.user);
      if (msg.fields && msg.fields.length > 0) {
        this.deps.sessions.assertWritable(id, this.user);
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
      const entry = this.deps.sessions.assertWritable(id, this.user);
      const ok = entry.session.selectGuiChoice(msg.fieldId, msg.choiceIndex, msg.selected ?? true);
      if (!ok) throw new Tn5250Error("FIELD_TYPE", `選択できません（fieldId=${msg.fieldId}）`);
      // 更新画面は session の screen イベントで push される
    });
  }

  private async onGuiSubmit(msg: WsClientMessage & { type: "gui-submit" }): Promise<void> {
    const id = this.requireSession();
    await withAudit({ op: "ws_gui_submit", sessionId: id }, async () => {
      const entry = this.deps.sessions.assertWritable(id, this.user);
      const opts: { key?: AidKey; cursor?: { row: number; col: number } } = {};
      if (msg.key) opts.key = msg.key as AidKey;
      if (msg.cursor) opts.cursor = msg.cursor;
      await entry.session.submitGuiSelection(msg.fieldId, opts);
    });
  }

  private async onJobInfo(msg: WsClientMessage & { type: "jobinfo" }): Promise<void> {
    const id = this.requireSession();
    await withAudit({ op: "ws_jobinfo", sessionId: id }, async () => {
      const entry = this.deps.sessions.assertWritable(id, this.user);
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
    this.detachReport?.();
    this.detachReport = undefined;
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
