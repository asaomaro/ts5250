/**
 * データ待ち行列の**常駐監視**の状態（`20260723-dtaq-watch-notify`）。
 *
 * ## セッションの store と分けている理由
 *
 * 監視は**サーバーのレジストリが所有する**。ブラウザを閉じても続き、タブを閉じても止まらない
 * （research F1）。つまり `sessionsStore`（1 タブ = 1 接続で、閉じたら切断）とは
 * **寿命の規則がまるで違う**ので同じ箱に入れない。
 *
 * ここが持つのは**サーバーの状態の写し**だけ。真実は常にサーバー側にあり、
 * 購読したときに一覧を配り直してもらう（`watch-subscribe` → `watch-list`）。
 *
 * ## WS は自前で 1 本張る
 *
 * 監視コンソールは pane タブで 5250 セッションを持たないため、
 * セッション用の WS には乗れない。`watch-*` は `open` を要さないので 1 本だけ張る。
 */
import { reactive } from "vue";
import type { WatchView, WatchEntryView, WsServerMessage } from "@ts5250/server";
import { WsClient, wsUrl } from "../ws-client.js";

/** 履歴の保持件数（画面側）。サーバー側の上限（200）と同じにして食い違いを作らない */
const HISTORY_LIMIT = 200;

const state = reactive({
  /** サーバーが持っている監視の一覧（購読で配られる） */
  watches: [] as WatchView[],
  /** 監視ごとの履歴（`watchId` → 到着順） */
  histories: new Map<string, WatchEntryView[]>(),
  /** 監視ごとの未読（タブを開いたら 0 に戻す） */
  unread: new Map<string, number>(),
  /** 直近のエラー（開始に失敗した等）。画面に出す */
  error: "",
  connected: false
});

let client: WsClient | undefined;
let connecting: Promise<void> | undefined;

function onMessage(msg: WsServerMessage): void {
  switch (msg.type) {
    case "watch-list":
      state.watches = msg.watches;
      // 消えた監視の履歴・未読は捨てる（サーバーに無いものを画面が持ち続けない）
      for (const id of [...state.histories.keys()]) {
        if (!msg.watches.some((w) => w.id === id)) {
          state.histories.delete(id);
          state.unread.delete(id);
        }
      }
      break;
    case "watch-entry": {
      const list = state.histories.get(msg.watchId) ?? [];
      list.push(msg.entry);
      if (list.length > HISTORY_LIMIT) list.splice(0, list.length - HISTORY_LIMIT);
      state.histories.set(msg.watchId, list);
      state.unread.set(msg.watchId, (state.unread.get(msg.watchId) ?? 0) + 1);
      const w = state.watches.find((x) => x.id === msg.watchId);
      if (w) w.received = msg.received;
      break;
    }
    case "watch-state": {
      const w = state.watches.find((x) => x.id === msg.watchId);
      if (w) {
        w.state = msg.state;
        if (msg.error !== undefined) w.error = msg.error;
        else delete w.error;
      }
      break;
    }
    case "watch-history":
      state.histories.set(msg.watchId, msg.entries);
      break;
    case "error":
      state.error = msg.message;
      break;
    default:
      break; // 監視に関係のないメッセージは無視（同じ WS 型を共有しているため）
  }
}

export const watchesStore = reactive({
  get watches(): WatchView[] {
    return state.watches;
  },
  get error(): string {
    return state.error;
  },
  get connected(): boolean {
    return state.connected;
  },

  /**
   * その監視の履歴（新しいものが後ろ）。
   *
   * **選んでいる監視は画面側が持つ**——監視コンソールはシステムごとに分かれた
   * （`watchScope.ts`）ので、選択が store にあると **2 枚のコンソールが 1 つの選択を
   * 奪い合う**（片方で行を選ぶともう片方の履歴まで入れ替わる）。
   */
  historyOf(id: string | undefined): WatchEntryView[] {
    return id === undefined ? [] : (state.histories.get(id) ?? []);
  },

  /**
   * 履歴をまだ持っていなければ取り寄せる（行を選んだとき・一覧が届いたときに呼ぶ）。
   *
   * **一覧が来ただけでは履歴は付いてこない。** これを呼ばないとリロード後に
   * 「監視は出ているのに履歴が空」になる（実機 E2E で踏んだ）。requirement の
   * 「開き直すと閉じていた間の到着が履歴にある」はここが要る。
   */
  ensureHistory(id: string | undefined): void {
    if (id !== undefined && !state.histories.has(id)) client?.send({ type: "watch-history", watchId: id });
  },

  /** その監視の未読件数（一覧の行に出す） */
  unreadOf(id: string): number {
    return state.unread.get(id) ?? 0;
  },

  /**
   * 全監視の未読合計。
   *
   * **タブのバッジはこれではない**——コンソールがシステムごとに分かれてからは、
   * そのタブに出る監視だけを数える（`watchScope.ts` の `unreadForTab`）。
   */
  get totalUnread(): number {
    let n = 0;
    for (const v of state.unread.values()) n += v;
    return n;
  },

  /**
   * 購読する（冪等）。**タブを開くたびに呼んでよい**——
   * サーバーが今ある監視の一覧を配り直すので、閉じていた間の変化がここで揃う。
   */
  async connect(): Promise<void> {
    if (client) {
      client.send({ type: "watch-subscribe" });
      return;
    }
    if (connecting) return connecting;
    const c = new WsClient(wsUrl(), { onServerMessage: onMessage }, "監視");
    connecting = c
      .connect()
      .then(() => {
        client = c;
        state.connected = true;
        c.send({ type: "watch-subscribe" });
      })
      .catch((e: unknown) => {
        state.error = e instanceof Error ? e.message : String(e);
      })
      .finally(() => {
        connecting = undefined;
      });
    return connecting;
  },

  /** セッション設定（`srv:` / `own:`）から監視を始める */
  async start(ref: string): Promise<void> {
    state.error = "";
    await this.connect();
    client?.send({ type: "watch-start", session: ref });
  },

  stop(id: string): void {
    state.error = "";
    client?.send({ type: "watch-stop", watchId: id });
  },

  /**
   * 停止した監視を再開する（`20260801-service-start-stop`）。
   *
   * **`start` とは別の口。** あちらは「定義から**作って**始める」ので、
   * 既にあるものに使うと二重に掛かる——監視は消費するので、2 本掛かると
   * 1 本ぶんのエントリを取り合って両方が欠ける。
   */
  resume(id: string): void {
    state.error = "";
    client?.send({ type: "watch-resume", watchId: id });
  },

  /**
   * 未読を消す（**タブを開いたとき**）。プリンターの `markSpoolRead` と同じ挙動。
   * 履歴そのものは消さない。
   *
   * **消す範囲を受け取る。** コンソールはシステムごとに分かれたので、全部消すと
   * 開いていないシステムの新着まで既読になり、そのタブのバッジが二度と出ない。
   */
  markRead(ids?: readonly string[]): void {
    if (ids === undefined) state.unread.clear();
    else for (const id of ids) state.unread.delete(id);
  },

  /** テスト用の初期化 */
  reset(): void {
    state.watches = [];
    state.histories.clear();
    state.unread.clear();
    state.error = "";
    state.connected = false;
    client = undefined;
    connecting = undefined;
  }
});
