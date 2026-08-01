// @as400web/core 公開 API

// ロガー（stderr 固定。spec D9）
export {
  log,
  childLog,
  setLogSink,
  resetLogSink,
  type CoreLogger,
  type LogFn
} from "@as400web/base";

// エラー
export {
  As400Error,
  /** 旧名の互換シム（同一クラス）。新しいコードでは As400Error を使う */
  Tn5250Error,
  describeSocketError,
  withSocketHint,
  type ErrorCode
} from "@as400web/base";

// 画面モデル（共有型。server / web-ui が import する）
export type {
  ScreenSnapshot,
  WriteExtent,
  Cell,
  Field,
  FieldAdjust,
  ScreenColor,
  CellKind,
  GuiConstructs,
  GuiSelectionField,
  GuiSelectionKind,
  GuiChoice,
  GuiWindow,
  GuiWindowBorder,
  GuiWindowBorderChars,
  GuiGridLine,
  GuiScrollBar
} from "./screen/types.js";

// セッション（ConnectOptions に RFC 4777 自動サインオンの user/password を含む。decisions.md D3）
export {
  Session5250,
  type ConnectOptions,
  type SessionState,
  type SendAidOptions,
  type SendAidResult,
} from "./session/session.js";
export { aidCodeOf, aidKeyForCode, type AidKey } from "./session/aid-keys.js";
// プリンターセッション（SCS 受信 → 論理ページ）
export {
  PrinterSession,
  type PrinterConnectOptions,
  type SpoolReport
} from "./session/printer-session.js";
/** SCS デコーダは `@as400web/scs` に分離済み。既存の利用側のために root から再輸出する */
export { ScsDecoder, type LogicalPage } from "@as400web/scs";
export {
  parseWdsf,
  GRID_COLOR,
  WDSF_TYPE,
  type WdsfEvent,
  type ParsedSelectionField,
  type ParsedWindow,
  type ParsedScrollBar,
  type ParsedChoice
} from "./protocol/wdsf-parser.js";

// 文字変換（SBCS / DBCS）。実体は `@as400web/ebcdic` に分離済み——既存の利用側のために再輸出する
export {
  SbcsCodec,
  DbcsCodec,
  codecForCcsid,
  katakanaChar,
  latinChar,
  SO,
  SI,
  type Codec,
  type SbcsTable,
  type StatefulTable
} from "@as400web/ebcdic";
export {
  terminalTypeFor,
  printerTerminalTypeFor,
  isDbcsCcsid,
  deviceEnvFor,
  type DeviceEnv
} from "./session/terminal-type.js";

// transport / telnet（capture スクリプト・テスト・上位実装向け）
export type { Transport } from "./transport/types.js";
export { TcpTransport, type TcpConnectOptions } from "./transport/tcp.js";
export { TelnetLayer, type TelnetOptions } from "./telnet/telnet.js";

// 低レベルプロトコル（capture/デバッグ・上位実装向け）
export { parseRecord, buildRecord, type ParsedRecord, type RecordHeaderFlags } from "./protocol/gds.js";
// PC Organizer（STRPCCMD）: 実行係は server が持つのでリクエスト型を公開する
export { type PcCommandRequest, PCO_START, PCO_END } from "./protocol/pc-command.js";

// トレース / リプレイ（spec D10）
export {
  TraceRecorder,
  parseTraceJsonl,
  bytesToHex,
  hexToBytes,
  type TraceEntry,
  type TraceRecorderOptions
} from "./trace/trace.js";
export { ReplayTransport } from "./trace/replay.js";

// ここから下のホストサーバー（IBM i Host Server。TN5250 とは別プロトコル）は、
// **実体が `@as400web/hostserver` にあり、ここは後方互換のための再輸出**である
// （`20260801-library-extraction-hostserver`）。`packages/server` の 37 ファイルが
// この経路で使っているので、**列挙を落とすと外の利用者だけが壊れる**——内部は何も壊れず
// 型検査もビルドも通る。到達可能性は `test/hostserver-reexport.test.ts` が実行時に検査する。
//
// **新しいコードは `@as400web/hostserver` を直接使うこと。**
//
// ※ かつてここには「第1段階として signon サーバーの認証のみ。SQL・データ転送は未実装」と
//   書いてあったが、その後 SQL・IFS・DDM・DTAQ・スプール・各種一覧まで載って実態と乖離していた。
export {
  signon,
  SignonError,
  type SignonOptions,
  type SignonResult,
  type HostServerInfo,
  type HostServerTlsOptions
} from "@as400web/hostserver";
export {
  resolveServicePort,
  type HostService,
  type ResolvePortOptions,
  SERVICE_NAME,
  DEFAULT_PORT,
  PORT_MAPPER_PORT
} from "@as400web/hostserver";
export {
  classifySignonReturnCode,
  describeSignonFailure,
  type SignonFailure,
  type SignonFailureKind
} from "@as400web/hostserver";

// ホストサーバー: SQL（database サーバー）
export { DbConnection, type DbConnectOptions } from "@as400web/hostserver";
export { openQuery } from "@as400web/hostserver";
export { type LobOptions } from "@as400web/hostserver";
export { retrieveLob, DEFAULT_LOB_MAX_BYTES, type RetrievedLob } from "@as400web/hostserver";
export { query, stream, SqlError, type Row, type QueryResult } from "@as400web/hostserver";
// 上限つき取得。**ホストから取ってくる量**を抑える（`query` は全件取得）
export { queryLimited, type LimitedResult } from "@as400web/hostserver";
export type { ColumnMeta, DbValue } from "@as400web/hostserver";
export { DB2, typeName, jsTypeOf, type JsType } from "@as400web/hostserver";
// 結果を返さない文（DML / DDL）。判定は純関数で、実行は SQLCODE で成否を見る
export { executeStatement, type ExecuteResult } from "@as400web/hostserver";
export {
  isNonQueryStatement,
  isRowCountStatement,
  hasParameterMarker
} from "@as400web/hostserver";
// 純 DBCS（GRAPHIC 列用）
export {
  PureDbcsCodec,
  pureDbcsCodecForCcsid,
  isPureDbcsCcsid,
  ibm16684,
  ibm300
} from "@as400web/ebcdic";

// ホストサーバー: コマンド実行（コマンドサーバー。CL 実行とプログラム呼び出し）
export {
  CommandConnection,
  CommandError,
  type CommandConnectOptions,
  type CommandResult
} from "@as400web/hostserver";
export {
  classifySeverity,
  describeMessage,
  type HostMessage,
  type MessageKind
} from "@as400web/hostserver";
export type { ProgramParameter } from "@as400web/hostserver";

// ホストサーバー: スプール（一覧＝コマンドサーバー / 中身＝ネットワーク印刷サーバー）
export { listSpooledFiles, parseSpoolRecord, buildFilter } from "@as400web/hostserver";
export {
  statusName,
  cyymmddToIso,
  hhmmssToReadable,
  type SpoolId,
  type SpoolEntry,
  type SpoolListFilter
} from "@as400web/hostserver";
export {
  NetPrintConnection,
  type NetPrintConnectOptions,
  type SpoolMessage
} from "@as400web/hostserver";
export {
  NP_ACTION,
  NP_CP,
  NP_ATTR,
  NP_RC,
  buildAttributeList,
  buildNpRequest,
  parseNpReply,
  findCodePoint,
  type NpAttribute
} from "@as400web/hostserver";

// ホストサーバー: IFS ファイルの読み書き
export {
  IfsConnection,
  type IfsConnectOptions,
  type IfsListOptions,
  type IfsTextFile
} from "@as400web/hostserver";
export type { IfsEntry, IfsListResult } from "@as400web/hostserver";
// CCSID 指定のテキスト復号・符号化（IFS のプレビューと保存が使う）
export {
  canDecodeCcsid,
  canEncodeCcsid,
  decodeCcsidText,
  encodeCcsidText,
  isEbcdicCcsid,
  TEXT_CCSIDS,
  ccsidLabel,
  type CcsidText,
  type LineEnding
} from "@as400web/ebcdic";

// ホストサーバー: データ待ち行列
export { DtaqConnection, type DtaqConnectOptions } from "@as400web/hostserver";
// 別名は `@as400web/hostserver` 側で付け終わっている（`decodeEbcdic` / `CreateOptions` 等の
// 汎用すぎる名前を dtaq 接頭辞付きにするのは、分割前は core の役目だった）。
// **外へ出る名前は分割前と同一**で、ここは受け直しているだけ。
export { dtaqDecodeEbcdic } from "@as400web/hostserver";
export type {
  DtaqEntry,
  DtaqAttributes,
  DtaqType,
  DtaqCreateOptions,
  DtaqReadOptions,
  DtaqSearchOrder
} from "@as400web/hostserver";

// ホストサーバー: 各種一覧（QGY オープンリスト）
export { listObjects, type ObjectEntry, type ObjectListFilter } from "@as400web/hostserver";
export { listUsers, type UserEntry, type UserListFilter } from "@as400web/hostserver";
export { listJobs, type JobEntry, type JobListFilter } from "@as400web/hostserver";

// DDM（レコードレベル書き込み）
export {
  DdmConnection,
  buildDdmRecord,
  type DdmRecord,
  buildRecordLayout,
  type DdmConnectOptions,
  type DdmFile,
  type WriteAllResult,
  maxBatchSize,
  effectiveBatchSizeFor,
  type ColumnLayoutInput,
  type RecordLayout
} from "@as400web/hostserver";
export {
  encodeChar,
  encodeInt,
  encodePacked,
  encodeZoned
} from "@as400web/hostserver";
export { type FieldLayout } from "@as400web/hostserver";
export { fetchColumnLayout } from "@as400web/hostserver";
export { assertIdentifier, isValidIdentifier, IDENTIFIER_PATTERN } from "@as400web/base";
export {
  prepareUpload,
  type PrepareUploadArgs,
  type PrepareResult,
  type PreparedUpload,
  type UploadColumn,
  type UploadRejection
} from "@as400web/hostserver";

// CSV 解析（取り込みの入口。web-ui と MCP が同じ実装を使う）
export { parseCsv, type CsvParseResult } from "./csv-parse.js";

// SQL 経由の行追加（パラメータマーカー）
export {
  insertRows,
  batchSizeFor,
  InsertEncodeError,
  DEFAULT_MAX_BATCH_BYTES,
  type InsertResult,
  type InsertRowsArgs
} from "@as400web/hostserver";
export { parseMarkerFormat, type MarkerFormat, type MarkerField } from "@as400web/hostserver";
export {
  encodeMarkerRow,
  buildMarkerData,
  markerDataSize,
  MarkerEncodeError,
  type MarkerRow
} from "@as400web/hostserver";

// 画面 → 自己完結 HTML（エビデンス出力）
export {
  renderScreenHtml,
  renderScreenHistoryHtml,
  type ScreenHtmlMeta,
  type ScreenHistoryEntry
} from "./html/screen-html.js";

// スプール（帳票）→ 自己完結 HTML。PDF（server 側 `renderSpoolPdf`）の HTML 版
export { renderSpoolHtml, type SpoolHtmlMeta } from "./html/spool-html.js";

/** 全角判定（East Asian Width）。桁を数える側と描く側で表を分けない */
export { isFullWidth, isCertainWideGlyph } from "./text/east-asian-width.js";
