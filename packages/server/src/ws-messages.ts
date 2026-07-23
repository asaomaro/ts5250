import type { ScreenSnapshot } from "@as400web/core";
import type { SessionJob } from "./session-manager.js";

/** WebSocket メッセージ型（server が定義し web-ui が type-only import で共有。spec「Web 向けプロトコル」） */

// ---- client → server ----
export interface WsOpen {
  type: "open";
  /** セッション種別（既定 display）。printer は TN5250E プリンターセッション */
  kind?: "display" | "printer";
  /** システム参照（`srv:<name>` / `own:<id>`）。接続先と資格情報を決める */
  system?: string;
  /** セッション設定参照。指定すると親システムまで一意に決まる（基本形） */
  session?: string;
  host?: string;
  port?: number;
  ccsid?: number;
  /** 画面サイズ。27x132 は端末タイプで申告し、ホストが対応画面でのみ使う（既定 24x80） */
  screenSize?: "24x80" | "27x132";
  deviceName?: string;
  enhanced?: boolean;
  tls?: boolean;
  /** RFC 4777 自動サインオン（host 直指定時。system/session 指定時はシステム側の signon を使う） */
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
  /** ジョブ識別子。接続直後は装置名（＝ジョブ名）だけのことがある */
  job?: SessionJob;
}
export interface WsScreen {
  type: "screen";
  screen: ScreenSnapshot;
}
/**
 * ジョブ識別子の通知（**サーバー発のみ**）。
 *
 * 装置名は接続直後の `opened` に載る。ユーザー・番号はコマンドサーバーで引けたときに
 * 遅れて届くので、このメッセージで足す。**クライアントから要求する口は無い**——
 * 取得は画面に触れずに自動で行われる（DSPJOB を打つ旧経路は廃止した）。
 */
export interface WsJobInfoRes {
  type: "jobinfo";
  job: SessionJob;
}
/**
 * AID 送信の処理が終わった合図。
 *
 * **画面が返らないキーがあるため必要**——応答画面は screen イベントで push されるが、
 * ホストが表示を変えない場合はイベントが起きず、クライアントの「応答待ち」が永久に残る。
 * sendAid の完了そのものを伝えることで、画面の有無に依らず待ちを解ける。
 */
export interface WsKeyDone {
  type: "key-done";
  sessionId: string;
  /**
   * 完了時点の画面。**タイムアウト復帰で必要**——ホストがアンロックを伴う応答を返さないと
   * screen イベントが出ないまま `keyboardLocked: true` の画面が残り、UI の 🔒 が消えない。
   * sendAid の戻り値には解除後の画面が入っているので、それを必ず届ける。
   */
  screen: ScreenSnapshot;
  /** ホスト応答を待たずタイムアウトで復帰したか */
  timedOut: boolean;
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
  /** 既受信スプールの自動出力結果（後から画面を開いても成否が分かるように配送） */
  outputStatuses: SpoolOutputStatusMsg[];
}
/** 1 スプールに対する自動出力の結果（成功も含む）。設定が無い側はキーを省略する */
export interface SpoolOutputStatusMsg {
  spoolId: string;
  at: number;
  skipped?: boolean;
  pdf?: { ok: boolean; path?: string; error?: string };
  print?: { ok: boolean; printer?: string; error?: string };
}
/** 受信スプールの自動出力結果（PDF 作成・印刷の成否）を通知する */
export interface WsPrinterOutputResult {
  type: "printer-output-result";
  sessionId: string;
  status: SpoolOutputStatusMsg;
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
  | WsKeyDone
  | WsPrinterOpened
  | WsPrinterWarn
  | WsPrinterOutputState
  | WsPrinterOutputResult
  | WsReport;
