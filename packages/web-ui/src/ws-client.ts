import type { WsClientMessage, WsServerMessage } from "@as400web/server";
import { logStore, maskOutgoing } from "./stores/log.js";

export interface WsClientHandlers {
  onServerMessage(msg: WsServerMessage): void;
}

/**
 * 1 セッション = 1 WebSocket 接続（spec D12: 多重化しない）。
 * 送受信を logStore にフックし、送信時は hidden フィールド値を伏字化してから記録する。
 */
export class WsClient {
  private ws: WebSocket | undefined;
  private sessionLabel: string;
  private hiddenIndexes = new Set<number>();
  private lastKeyAt: number | undefined;

  constructor(
    private readonly url: string,
    private readonly handlers: WsClientHandlers,
    label = "session"
  ) {
    this.sessionLabel = label;
  }

  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(this.url);
      this.ws = ws;
      ws.addEventListener("open", () => resolve());
      ws.addEventListener("error", () => reject(new Error("websocket error")));
      ws.addEventListener("message", (ev) => this.onMessage(String(ev.data)));
      ws.addEventListener("close", () => this.log("event", "closed", "ws closed"));
    });
  }

  /** 現在画面の hidden フィールド index を記録（送信時マスクに使う） */
  setHiddenIndexes(indexes: Iterable<number>): void {
    this.hiddenIndexes = new Set(indexes);
  }

  send(msg: WsClientMessage): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    if (msg.type === "key") this.lastKeyAt = now();
    const masked = maskOutgoing(msg, this.hiddenIndexes);
    this.log("tx", msg.type, summarize(masked), masked);
    this.ws.send(JSON.stringify(msg));
  }

  close(): void {
    this.ws?.close();
  }

  private onMessage(raw: string): void {
    let msg: WsServerMessage;
    try {
      msg = JSON.parse(raw) as WsServerMessage;
    } catch {
      return;
    }
    const rt = msg.type === "screen" && this.lastKeyAt !== undefined ? now() - this.lastKeyAt : undefined;
    if (msg.type === "screen") this.lastKeyAt = undefined;
    this.log("rx", msg.type, summarize(msg), msg, rt, msg.type === "error");
    this.handlers.onServerMessage(msg);
  }

  private log(dir: "tx" | "rx" | "event", kind: string, summary: string, detail?: unknown, rt?: number, err?: boolean): void {
    logStore.add({
      ts: now(),
      sessionId: this.sessionLabel,
      dir,
      kind,
      summary,
      ...(detail !== undefined ? { detail } : {}),
      ...(rt !== undefined ? { roundtripMs: rt } : {}),
      ...(err ? { error: true } : {})
    });
  }
}

function now(): number {
  return typeof performance !== "undefined" ? performance.now() : Date.now();
}

function summarize(msg: unknown): string {
  if (typeof msg !== "object" || msg === null) return "";
  const m = msg as Record<string, unknown>;
  switch (m["type"]) {
    case "key":
      return `${String(m["key"])}${m["cursor"] ? ` cursor=(${(m["cursor"] as { row: number }).row},${(m["cursor"] as { col: number }).col})` : ""}${Array.isArray(m["fields"]) ? ` fields=${m["fields"].length}` : ""}`;
    case "screen":
    case "opened": {
      const s = m["screen"] as { rows?: number; cols?: number; fields?: unknown[] } | undefined;
      return s ? `${s.rows}x${s.cols} fields=${s.fields?.length ?? 0}` : "";
    }
    case "jobinfo": {
      const j = m["job"] as { number?: string } | undefined;
      return j ? `job ${j.number}` : "jobinfo";
    }
    case "error":
      return `${String(m["code"])}: ${String(m["message"])}`;
    default:
      return String(m["type"] ?? "");
  }
}
