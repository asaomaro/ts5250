import type { ScreenSnapshot, JobInfo } from "@as400web/core";

/** WebSocket メッセージ型（server が定義し web-ui が type-only import で共有。spec「Web 向けプロトコル」） */

// ---- client → server ----
export interface WsOpen {
  type: "open";
  /** セッション種別（既定 display）。printer は TN5250E プリンターセッション */
  kind?: "display" | "printer";
  /** 保存済みユーザー接続の ID 参照（サーバーが host/資格情報を解決）。profile/host より優先 */
  connection?: string;
  profile?: string;
  host?: string;
  port?: number;
  ccsid?: number;
  /** 画面サイズ。27x132 は端末タイプで申告し、ホストが対応画面でのみ使う（既定 24x80） */
  screenSize?: "24x80" | "27x132";
  deviceName?: string;
  enhanced?: boolean;
  tls?: boolean;
  /** RFC 4777 自動サインオン（host 直指定時。profile 指定時は profile 側の signon を使う） */
  user?: string;
  password?: string;
  readOnly?: boolean;
}
export interface WsKey {
  type: "key";
  key: string;
  cursor?: { row: number; col: number };
  fields?: { field: number | { row: number; col: number }; value: string }[];
}
export interface WsJobInfoReq {
  type: "jobinfo";
  refresh?: boolean;
}
export interface WsCloseReq {
  type: "close";
}
/** GUI 選択フィールドの選択状態変更（ローカル・ホスト送信なし） */
export interface WsGuiSelect {
  type: "gui-select";
  fieldId: number;
  choiceIndex: number;
  selected?: boolean;
}
/** GUI 選択フィールドの確定送信（AID/Enter を Read 応答として送る） */
export interface WsGuiSubmit {
  type: "gui-submit";
  fieldId: number;
  key?: string;
  cursor?: { row: number; col: number };
}
export type WsClientMessage =
  | WsOpen
  | WsKey
  | WsJobInfoReq
  | WsCloseReq
  | WsGuiSelect
  | WsGuiSubmit
  | WsPrinterOutput;

// ---- server → client ----
export interface WsOpened {
  type: "opened";
  sessionId: string;
  screen: ScreenSnapshot;
  /** セッションの実効ホストコードページ（CCSID）。既定 37 */
  ccsid: number;
}
export interface WsScreen {
  type: "screen";
  screen: ScreenSnapshot;
}
export interface WsJobInfoRes {
  type: "jobinfo";
  job: JobInfo;
  cached: boolean;
}
export interface WsError {
  type: "error";
  code: string;
  message: string;
  fatal: boolean;
}
export interface WsClosed {
  type: "closed";
  reason: string;
}
/** 出力（PDF 保存・自動印刷）の警告 1 件 */
export interface PrinterOutputWarning {
  at: number;
  message: string;
}
/** プリンターセッションを開いた（起動応答コード＋自動出力の状態） */
export interface WsPrinterOpened {
  type: "printer-opened";
  sessionId: string;
  startupCode: string;
  /** サーバー側の自動出力設定があるか（UI のトグル表示条件） */
  hasOutput: boolean;
  /** 自動出力の実行時 有効/無効 */
  outputEnabled: boolean;
  /** 既存の出力警告（後から画面を開いても直近の失敗が分かるように配送） */
  outputWarnings: PrinterOutputWarning[];
}
/** 自動出力が失敗した（PDF 保存 / lp 印刷）。非同期に発生するので push する */
export interface WsPrinterWarn {
  type: "printer-warn";
  sessionId: string;
  at: number;
  message: string;
}
/** 自動出力の有効/無効が変わった（クライアントの切替に対する応答） */
export interface WsPrinterOutputState {
  type: "printer-output-state";
  sessionId: string;
  enabled: boolean;
}
/** スプール（帳票）1 件を受信した。pages は等幅グリッド（生 SCS は載せない） */
export interface WsReport {
  type: "report";
  sessionId: string;
  report: { id: string; pages: { rows: number; cols: number; lines: string[] }[] };
}
/** client → server: 自動出力の有効/無効を切り替える */
export interface WsPrinterOutput {
  type: "printer-output";
  enabled: boolean;
}
export type WsServerMessage =
  | WsOpened
  | WsScreen
  | WsJobInfoRes
  | WsError
  | WsClosed
  | WsPrinterOpened
  | WsPrinterWarn
  | WsPrinterOutputState
  | WsReport;
