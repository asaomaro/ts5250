import type { WsClientMessage, WsServerMessage } from "@ts5250/server";
import { logStore, maskOutgoing } from "./stores/log.js";

export interface WsClientHandlers {
  onServerMessage(msg: WsServerMessage): void;
  /**
   * **WebSocket そのものが閉じた**（サーバー再起動・回線断・プロキシのアイドル切断）。
   *
   * サーバー発の `closed` メッセージとは別物で、**あちらは届かないことがある**——
   * 経路が死んでいるのだから当然で、こちらだけが唯一の合図になる。受け取る側は
   * 待ち（`busy` / `loading`）を必ず解くこと。解かないと応答待ちの表示が永久に残る。
   */
  onClose?(): void;
}

/**
 * `/ws` の URL。**接続する側が 2 つある**（セッションと監視コンソール）ので、
 * 組み立てはここ 1 か所に置く。
 */
export const wsUrl = (): string => {
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${location.host}/ws`;
};

/**
 * 操作ログに残さないメッセージ種別。
 *
 * 心拍（30 秒）と在席の合図（15 秒）は利用者の操作ではなく、出すと**操作ログが心拍で埋まって
 * 使えなくなる**。マスク対象も無い（どちらも payload を持たない）。
 */
const QUIET_TYPES: ReadonlySet<string> = new Set(["activity", "pong"]);

/**
 * **サーバーの `ping` がこの時間来なければ死んだとみなす**
 * （`20260908-session-survives-disconnect` decisions D6）。
 *
 * サーバーは半開き（TCP は死んでいるのに `close` イベントが来ない）を自分で畳むのに、
 * **こちら側には対応する見張りが無かった**。`close` が飛ばない切れ方では、応答待ちの表示が
 * 永久に残ったまま誰も気づかない。
 *
 * 値はサーバーの死判定（`ws-handler.ts` の `HEARTBEAT_DEAD_MS`）と同じにしてある——
 * 心拍は 30 秒間隔なので、3 回落とせば死んでいる、という同じ根拠を両側で使う。
 */
const PING_DEAD_MS = 90_000;

/**
 * 見張りが `close()` を呼んでから、**`close` イベントを待つ猶予**。
 *
 * 半開きはまさに closing handshake が完結しない状況なので、`close()` を呼んでも
 * イベントが（ブラウザ実装のタイムアウトぶん）遅れる／来ないことがある。
 * **90 秒かけて死を判定した意味が消える**ので、来なければこちらから同じ後始末へ進む。
 */
const CLOSE_EVENT_GRACE_MS = 3_000;

/**
 * 1 セッション = 1 WebSocket 接続（spec D12: 多重化しない）。
 * 送受信を logStore にフックし、送信時は hidden フィールド値を伏字化してから記録する。
 */
export class WsClient {
  private ws: WebSocket | undefined;
  private sessionLabel: string;
  private hiddenIndexes = new Set<number>();
  private lastKeyAt: number | undefined;
  /**
   * `ping` の見張り。**最初の `ping` を受け取るまで張らない。**
   *
   * `ping` を送らないサーバー（古い版）と繋いだときに、こちらが勝手に切ってしまうのを
   * 防ぐため。「来なくなったら死」なら、そもそも来ないサーバーには一度も発火しない。
   */
  private pingWatchdog: ReturnType<typeof setTimeout> | undefined;
  /** `close` イベントが来なかったときの保険。見張りが発火したときだけ張る */
  private closeFallback: ReturnType<typeof setTimeout> | undefined;
  /** 後始末を済ませたか。**イベントと保険の両方から来る**ので、二度流さないための鍵 */
  private closeNotified = false;
  /** 開く前に閉じたときに `connect()` を落とすための口（保険の経路からも使う） */
  private rejectConnect: ((err: Error) => void) | undefined;

  constructor(
    private readonly url: string,
    private readonly handlers: WsClientHandlers,
    label = "session"
  ) {
    this.sessionLabel = label;
  }

  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      // **前の接続の見張りを畳んでから始める。** 同じインスタンスで繋ぎ直したとき、
      // 旧ソケットの見張りが 90 秒後に**新しいソケットを閉じる**のを防ぐ
      this.clearPingWatchdog();
      this.clearCloseFallback();
      this.closeNotified = false;
      this.rejectConnect = reject;
      const ws = new WebSocket(this.url);
      this.ws = ws;
      ws.addEventListener("open", () => resolve());
      ws.addEventListener("error", () => reject(new Error("websocket error")));
      ws.addEventListener("message", (ev) => this.onMessage(String(ev.data)));
      // **ソケットを添えて渡す。** ハンドラはソケットではなくこのインスタンスに紐づくので、
      // 同じインスタンスで繋ぎ直すと**古いソケットの close が新しい接続の後始末をしてしまう**
      ws.addEventListener("close", () => this.notifyClosed(ws));
    });
  }

  /**
   * **閉じたことを 1 度だけ上へ伝える。**
   *
   * 入口は 2 つ——`close` イベントと、見張りが発火したあとの保険
   * （`CLOSE_EVENT_GRACE_MS`）。どちらから来ても後始末は同じにする
   * （`20260908-session-survives-disconnect` decisions D6「新しい経路は作らない」）。
   */
  private notifyClosed(ws: WebSocket): void {
    if (ws !== this.ws || this.closeNotified) return;
    this.closeNotified = true;
    this.clearPingWatchdog();
    this.clearCloseFallback();
    this.log("event", "closed", "ws closed");
    // **開く前に閉じたら connect() を落とす。** 解決済みの Promise への reject は
    // 無視されるので、開いた後の切断には影響しない。落とさないと
    // 「開いています」の await が永遠に返らない
    this.rejectConnect?.(new Error("websocket closed"));
    this.handlers.onClose?.();
  }

  /** 現在画面の hidden フィールド index を記録（送信時マスクに使う） */
  setHiddenIndexes(indexes: Iterable<number>): void {
    this.hiddenIndexes = new Set(indexes);
  }

  send(msg: WsClientMessage): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    if (msg.type === "key") this.lastKeyAt = now();
    if (QUIET_TYPES.has(msg.type)) {
      this.ws.send(JSON.stringify(msg));
      return;
    }
    const masked = maskOutgoing(msg, this.hiddenIndexes);
    this.log("tx", msg.type, summarize(masked), masked);
    this.ws.send(JSON.stringify(msg));
  }

  close(): void {
    this.clearPingWatchdog();
    this.clearCloseFallback();
    this.ws?.close();
  }

  /**
   * `ping` の見張りを張り直す。**`ping` を受け取るたび**に呼ぶ（前のものは捨てる）。
   *
   * **基準は `ping` だけ**——他の受信では張り直さない。データが流れていても `ping` が
   * 途絶えたら死とみなす、という判定にしておくことが、`ping` を送らないサーバーとの
   * 後方互換（見張り自体が始まらない）の根拠になっている（decisions D6）。
   *
   * **閉じたことを受け取れる相手のときだけ張る。** `onClose` を渡していない利用者
   * （監視コンソール）で閉じると、画面は「接続中」のまま送信だけが黙って捨てられる
   * ——気づけない切れ方を、こちらから作りにいくことになる。
   */
  private armPingWatchdog(): void {
    if (this.handlers.onClose === undefined) return;
    this.clearPingWatchdog();
    const ws = this.ws;
    this.pingWatchdog = setTimeout(() => {
      this.pingWatchdog = undefined;
      // **自分から畳んで、あとは既存の切断経路に任せる。** ここで独自の通知を作ると、
      // `close` が飛ぶ切れ方と半開きとで復帰の道筋が 2 本になる
      this.log("event", "ping-timeout", `no ping for ${PING_DEAD_MS}ms; closing`);
      // **閉じるのは見張り始めたソケット**（`this.ws` ではない）。繋ぎ直しで差し替わって
      // いた場合に、新しいソケットを巻き添えにしない
      ws?.close();
      // **`close` イベントが来ない場合の保険**（半開きでは来ないことがある）
      if (ws) this.closeFallback = setTimeout(() => this.notifyClosed(ws), CLOSE_EVENT_GRACE_MS);
    }, PING_DEAD_MS);
  }

  private clearCloseFallback(): void {
    if (this.closeFallback !== undefined) {
      clearTimeout(this.closeFallback);
      this.closeFallback = undefined;
    }
  }

  private clearPingWatchdog(): void {
    if (this.pingWatchdog !== undefined) {
      clearTimeout(this.pingWatchdog);
      this.pingWatchdog = undefined;
    }
  }

  private onMessage(raw: string): void {
    let msg: WsServerMessage;
    try {
      msg = JSON.parse(raw) as WsServerMessage;
    } catch {
      return;
    }
    // ハートビートは**この層で完結させる**。上（session-controller / コンポーネント）へ渡すと
    // 30 秒ごとに無意味な更新が伝わるし、操作ログにも残せない
    if (msg.type === "ping") {
      this.armPingWatchdog();
      this.send({ type: "pong" });
      return;
    }
    const rt = msg.type === "screen" && this.lastKeyAt !== undefined ? now() - this.lastKeyAt : undefined;
    if (msg.type === "screen") this.lastKeyAt = undefined;
    this.log("rx", msg.type, summarize(msg), msg, rt, msg.type === "error");
    this.handlers.onServerMessage(msg);
  }

  /**
   * 実セッション ID。open 応答で判明するまでは未定なのでラベルで代用する。
   * **絞り込みに使うのはこちら**——ラベルは重複しうる（同名の設定を 2 本開ける）。
   */
  private realSessionId: string | undefined;

  setSessionId(id: string): void {
    this.realSessionId = id;
  }

  private log(dir: "tx" | "rx" | "event", kind: string, summary: string, detail?: unknown, rt?: number, err?: boolean): void {
    logStore.add({
      ts: now(),
      sessionId: this.realSessionId ?? this.sessionLabel,
      label: this.sessionLabel,
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
      const j = m["job"] as { number?: string; name?: string } | undefined;
      return j ? `job ${j.number ? `${j.number}/${j.name}` : j.name}` : "jobinfo";
    }
    case "error":
      return `${String(m["code"])}: ${String(m["message"])}`;
    default:
      return String(m["type"] ?? "");
  }
}
