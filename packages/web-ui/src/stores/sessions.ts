import { reactive, markRaw } from "vue";
import type { ScreenSnapshot } from "@as400web/core";
import type { WsClient } from "../ws-client.js";

export interface SessionState {
  sessionId: string;
  label: string;
  snapshot: ScreenSnapshot | undefined;
  /** ローカル編集差分（fieldIndex → value）。AID 送信時に載せる */
  edits: Map<number, string>;
  cursor: { row: number; col: number };
  connected: boolean;
  readOnly: boolean;
  client: WsClient;
  job?: { number: string; user: string; name: string };
  /** ホスト応答待ち（通信中）。入力をプロテクトする */
  busy?: boolean;
  /** ローディング表示（通信が 0.5 秒以上かかったとき） */
  loading?: boolean;
}

export const sessionsStore = reactive({
  byId: new Map<string, SessionState>(),
  order: [] as string[],

  add(state: SessionState): void {
    // client は Vue のリアクティブ化から除外（外部オブジェクト）
    state.client = markRaw(state.client);
    this.byId.set(state.sessionId, state);
    if (!this.order.includes(state.sessionId)) this.order.push(state.sessionId);
  },

  get(id: string): SessionState | undefined {
    return this.byId.get(id);
  },

  remove(id: string): void {
    this.byId.delete(id);
    this.order = this.order.filter((x) => x !== id);
  },

  updateScreen(id: string, snapshot: ScreenSnapshot): void {
    const s = this.byId.get(id);
    if (!s) return;
    s.snapshot = snapshot;
    s.cursor = snapshot.cursor;
    s.connected = true;
    // ホスト発の新画面が来たらローカル編集差分はクリア（新フォーマット）
    s.edits.clear();
  }
});
