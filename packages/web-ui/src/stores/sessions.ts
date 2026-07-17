import { reactive, markRaw } from "vue";
import type { ScreenSnapshot } from "@as400web/core";
import type { WsClient } from "../ws-client.js";

/** プリンターセッションが受信した 1 スプール（等幅ページ列） */
export interface SpoolReportView {
  id: string;
  pages: { rows: number; cols: number; lines: string[] }[];
}

export interface SessionState {
  sessionId: string;
  label: string;
  /** セッション種別（既定 display）。printer は帳票ビュー（PrinterPane）で表示する */
  kind?: "display" | "printer";
  snapshot: ScreenSnapshot | undefined;
  /** ローカル編集差分（fieldIndex → value）。AID 送信時に載せる */
  edits: Map<number, string>;
  cursor: { row: number; col: number };
  connected: boolean;
  readOnly: boolean;
  client: WsClient;
  job?: { number: string; user: string; name: string };
  /** セッションの実効ホストコードページ（CCSID）。930/5026 は入力時に英小文字を大文字化する */
  ccsid?: number;
  /** ホスト応答待ち（通信中）。入力をプロテクトする */
  busy?: boolean;
  /** ローディング表示（通信が 0.5 秒以上かかったとき） */
  loading?: boolean;
  // ---- プリンターセッション（kind==="printer"）----
  /** 受信したスプール（帳票）一覧 */
  reports?: SpoolReportView[];
  /** ビューで選択中のスプール */
  selectedReportId?: string;
  /** 起動応答コード（I902 等） */
  startupCode?: string;
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
  },

  /** プリンターセッションに受信スプールを追加する（最初の 1 件は自動選択） */
  addReport(id: string, report: SpoolReportView): void {
    const s = this.byId.get(id);
    if (!s) return;
    if (!s.reports) s.reports = [];
    s.reports.push(report);
    if (!s.selectedReportId) s.selectedReportId = report.id;
  }
});
