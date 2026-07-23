// @as400web/core 公開 API

// ロガー（stderr 固定。spec D9）
export {
  log,
  childLog,
  setLogSink,
  resetLogSink,
  type CoreLogger,
  type LogFn
} from "./log.js";

// エラー
export {
  As400Error,
  /** 旧名の互換シム（同一クラス）。新しいコードでは As400Error を使う */
  Tn5250Error,
  describeSocketError,
  withSocketHint,
  type ErrorCode
} from "./errors.js";

// 画面モデル（共有型。server / web-ui が import する）
export type {
  ScreenSnapshot,
  Cell,
  Field,
  ScreenColor,
  CellKind,
  GuiConstructs,
  GuiSelectionField,
  GuiSelectionKind,
  GuiChoice,
  GuiWindow,
  GuiScrollBar
} from "./screen/types.js";

// セッション（ConnectOptions に RFC 4777 自動サインオンの user/password を含む。decisions.md D3）
export {
  Session5250,
  type ConnectOptions,
  type SessionState,
  type SendAidOptions,
  type SendAidResult,
  type JobInfo
} from "./session/session.js";
export { aidCodeOf, aidKeyForCode, type AidKey } from "./session/aid-keys.js";
// プリンターセッション（SCS 受信 → 論理ページ）
export {
  PrinterSession,
  type PrinterConnectOptions,
  type SpoolReport
} from "./session/printer-session.js";
export { ScsDecoder, type LogicalPage } from "./protocol/scs.js";
export {
  parseWdsf,
  WDSF_TYPE,
  type WdsfEvent,
  type ParsedSelectionField,
  type ParsedWindow,
  type ParsedScrollBar,
  type ParsedChoice
} from "./protocol/wdsf-parser.js";

// 文字変換（SBCS / DBCS）
export { SbcsCodec, DbcsCodec, codecForCcsid, katakanaChar, SO, SI, type Codec } from "./codec/codec.js";
export type { SbcsTable, StatefulTable } from "./codec/table-types.js";
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

// ホストサーバー（IBM i Host Server。TN5250 とは別プロトコル）
// 第1段階として signon サーバーの認証のみ。SQL・データ転送は未実装。
export {
  signon,
  SignonError,
  type SignonOptions,
  type SignonResult,
  type HostServerInfo,
  type HostServerTlsOptions
} from "./hostserver/signon.js";
export {
  resolveServicePort,
  type HostService,
  type ResolvePortOptions,
  SERVICE_NAME,
  DEFAULT_PORT,
  PORT_MAPPER_PORT
} from "./hostserver/port-mapper.js";
export {
  classifySignonReturnCode,
  describeSignonFailure,
  type SignonFailure,
  type SignonFailureKind
} from "./hostserver/return-codes.js";

// ホストサーバー: SQL（database サーバー。SELECT のみ。アップロードは未実装）
export { DbConnection, type DbConnectOptions } from "./hostserver/db/db-connection.js";
export { openQuery } from "./hostserver/db/query.js";
export { type LobOptions } from "./hostserver/db/query.js";
export { retrieveLob, DEFAULT_LOB_MAX_BYTES, type RetrievedLob } from "./hostserver/db/lob.js";
export { query, stream, SqlError, type Row, type QueryResult } from "./hostserver/db/query.js";
export type { ColumnMeta, DbValue } from "./hostserver/db/db-decode.js";
export { DB2, typeName, jsTypeOf, type JsType } from "./hostserver/db/db-types.js";
// 純 DBCS（GRAPHIC 列用）
export {
  PureDbcsCodec,
  pureDbcsCodecForCcsid,
  isPureDbcsCcsid,
  ibm16684,
  ibm300
} from "./codec/pure-dbcs.js";

// ホストサーバー: コマンド実行（コマンドサーバー。CL 実行とプログラム呼び出し）
export {
  CommandConnection,
  CommandError,
  type CommandConnectOptions,
  type CommandResult
} from "./hostserver/command/command-connection.js";
export {
  classifySeverity,
  describeMessage,
  type HostMessage,
  type MessageKind
} from "./hostserver/command/command-message.js";
export type { ProgramParameter } from "./hostserver/command/command-datastream.js";

// ホストサーバー: スプール（一覧＝コマンドサーバー / 中身＝ネットワーク印刷サーバー）
export { listSpooledFiles, parseSpoolRecord, buildFilter } from "./hostserver/spool/spool-list.js";
export {
  statusName,
  cyymmddToIso,
  hhmmssToReadable,
  type SpoolId,
  type SpoolEntry,
  type SpoolListFilter
} from "./hostserver/spool/spool-types.js";
export {
  NetPrintConnection,
  type NetPrintConnectOptions,
  type SpoolMessage
} from "./hostserver/spool/netprint-connection.js";
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
} from "./hostserver/spool/netprint-datastream.js";

// ホストサーバー: IFS ファイルの読み書き
export {
  IfsConnection,
  type IfsConnectOptions,
  type IfsListOptions,
  type IfsTextFile
} from "./hostserver/ifs/ifs-connection.js";
export type { IfsEntry, IfsListResult } from "./hostserver/ifs/ifs-types.js";
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
} from "./codec/ccsid-text.js";

// ホストサーバー: データ待ち行列
export { DtaqConnection, type DtaqConnectOptions } from "./hostserver/dtaq/dtaq-connection.js";
export { decodeEbcdic as dtaqDecodeEbcdic } from "./hostserver/dtaq/dtaq-datastream.js";
export type {
  DtaqEntry,
  DtaqAttributes,
  DtaqType,
  CreateOptions as DtaqCreateOptions,
  ReadOptions as DtaqReadOptions,
  SearchOrder as DtaqSearchOrder
} from "./hostserver/dtaq/dtaq-types.js";

// ホストサーバー: 各種一覧（QGY オープンリスト）
export { listObjects, type ObjectEntry, type ObjectListFilter } from "./hostserver/list/object-list.js";
export { listUsers, type UserEntry, type UserListFilter } from "./hostserver/list/user-list.js";
export { listJobs, type JobEntry, type JobListFilter } from "./hostserver/list/job-list.js";

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
} from "./hostserver/ddm/ddm-connection.js";
export {
  encodeChar,
  encodeInt,
  encodePacked,
  encodeZoned
} from "./hostserver/ddm/encode.js";
export { type FieldLayout } from "./hostserver/ddm/record-layout.js";
export { fetchColumnLayout } from "./hostserver/ddm/column-meta.js";
export { assertIdentifier, isValidIdentifier, IDENTIFIER_PATTERN } from "./identifier.js";
export {
  prepareUpload,
  type PrepareUploadArgs,
  type PrepareResult,
  type PreparedUpload,
  type UploadColumn,
  type UploadRejection
} from "./hostserver/db/upload-prepare.js";

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
} from "./hostserver/db/insert.js";
export { parseMarkerFormat, type MarkerFormat, type MarkerField } from "./hostserver/db/marker-format.js";
export {
  encodeMarkerRow,
  buildMarkerData,
  markerDataSize,
  MarkerEncodeError,
  type MarkerRow
} from "./hostserver/db/marker-encode.js";
