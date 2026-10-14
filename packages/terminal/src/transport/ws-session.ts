/**
 * サーバー（`@ts5250/server`）の WebSocket に繋ぐセッション。`SessionLike` を満たし、端末の操作部は
 * 直接接続（`Session5250`）と同じ `TerminalController` をそのまま使える。
 *
 * メッセージの型は server の `ws-messages.ts` から**必要な分だけ**構造的に写している——terminal は
 * server に依存しない（依存の向き。`dependency-direction.test.ts`）。web-ui と同じ約束で、打った値は
 * AID を送るときに `key.fields` でまとめて渡す（打鍵ごとには送らない）。
 */
import WebSocket from "ws";
import type { AidKey, ScreenSnapshot, SendAidOptions } from "@ts5250/tn5250";
import type { SessionLike } from "../app/controller.js";
import { overlayField } from "../app/overlay.js";

/** 開き方。`session`/`system` は `srv:`・`own:` の参照、`host` は直指定 */
export interface WsOpenSpec {
  session?: string;
  system?: string;
  sessionId?: string;
  host?: string;
  port?: number;
  tls?: boolean;
  ccsid?: number;
  screenSize?: "24x80" | "27x132";
  deviceName?: string;
  user?: string;
  password?: string;
}

interface ServerMsg {
  type: string;
  screen?: ScreenSnapshot;
  ccsid?: number;
  message?: string;
  code?: string;
  reason?: string;
  fatal?: boolean;
  timedOut?: boolean;
}

export class WsSession implements SessionLike {
  ccsid = 37;
  private base!: ScreenSnapshot;
  /** 欄の番号 → 編集値（AID を送るまで手元に持つ） */
  private edits = new Map<number, string>();
  private screenCbs: Array<(s: ScreenSnapshot) => void> = [];
  private closedCbs: Array<(r: string) => void> = [];
  private pending: { resolve: () => void } | undefined;
  private hostErrorSeq: number | undefined;

  private constructor(private readonly ws: WebSocket) {}

  /** 接続して `opened` を受けるまで待つ。失敗は例外（サーバーの文言をそのまま） */
  static async open(url: string, spec: WsOpenSpec): Promise<WsSession> {
    const ws = new WebSocket(url);
    const s = new WsSession(ws);
    await new Promise<void>((resolve, reject) => {
      ws.once("error", (e) => reject(e));
      ws.on("message", (data) => {
        let m: ServerMsg;
        try {
          m = JSON.parse(String(data)) as ServerMsg;
        } catch {
          return;
        }
        if (m.type === "opened" && m.screen) {
          s.base = m.screen;
          if (m.ccsid !== undefined) s.ccsid = m.ccsid;
          resolve();
          return;
        }
        if (m.type === "error" && m.fatal !== false && s.base === undefined) {
          reject(new Error(m.message ?? "サーバーがセッションを開けませんでした"));
          return;
        }
        s.onMessage(m);
      });
      ws.once("open", () => ws.send(JSON.stringify({ type: "open", ...spec })));
      ws.once("close", () => {
        if (s.base === undefined) reject(new Error("サーバーとの接続が閉じました"));
        else for (const cb of s.closedCbs) cb("サーバーとの接続が閉じました");
      });
    });
    return s;
  }

  private onMessage(m: ServerMsg): void {
    switch (m.type) {
      case "screen":
      case "key-done":
        if (m.screen) {
          this.base = m.screen;
          this.edits.clear(); // 新しい画面の欄の番号は別物。編集値は持ち越さない
          this.hostErrorSeq = (m.screen as { systemMessageSeq?: number }).systemMessageSeq;
          for (const cb of this.screenCbs) cb(this.snapshot());
        }
        if (m.type === "key-done") this.settle();
        return;
      case "error":
        this.settle();
        this.lastError = m.message ?? m.code ?? "エラー";
        return;
      case "closed":
        for (const cb of this.closedCbs) cb(m.reason ?? "サーバーがセッションを閉じました");
        return;
      case "ping":
        this.ws.send(JSON.stringify({ type: "pong" }));
        return;
      default:
    }
  }

  /** 直近のサーバーのエラー文言（`sendAid` の例外にして一度だけ返す） */
  private lastError: string | undefined;

  private settle(): void {
    const p = this.pending;
    this.pending = undefined;
    p?.resolve();
  }

  onScreen(cb: (s: ScreenSnapshot) => void): void {
    this.screenCbs.push(cb);
  }

  onClosed(cb: (r: string) => void): void {
    this.closedCbs.push(cb);
  }

  snapshot(): ScreenSnapshot {
    let snap = this.base;
    for (const [index, value] of this.edits) {
      const f = snap.fields.find((x) => x.index === index);
      if (f) snap = overlayField(snap, f, value);
    }
    return snap;
  }

  setField(target: { index: number }, value: string): void {
    this.edits.set(target.index, value);
  }

  async sendAid(key: AidKey, opts?: SendAidOptions): Promise<unknown> {
    const fields = [...this.edits].map(([field, value]) => ({ field, value }));
    this.lastError = undefined;
    const done = new Promise<void>((resolve) => {
      this.pending = { resolve };
    });
    this.ws.send(JSON.stringify({ type: "key", key, ...(opts?.cursor ? { cursor: opts.cursor } : {}), ...(fields.length ? { fields } : {}) }));
    // Attn / SysReq はサーバーが key-done を返さない（応答を待たない）ので待たない
    if (key === "Attn" || key === "SysReq") {
      this.pending = undefined;
      return undefined;
    }
    await done;
    if (this.lastError) throw new Error(this.lastError);
    return undefined;
  }

  dismissHostError(): boolean {
    if (this.hostErrorSeq === undefined || !this.base.keyboardLocked) return false;
    this.ws.send(JSON.stringify({ type: "dismiss-host-error", seq: this.hostErrorSeq }));
    return true;
  }

  disconnect(): void {
    try {
      this.ws.send(JSON.stringify({ type: "close" }));
    } finally {
      this.ws.close();
    }
  }
}
