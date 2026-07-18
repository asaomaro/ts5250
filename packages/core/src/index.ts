// @as400web/core 公開 API

// ロガー（stderr 固定。spec D9）
export { log, childLog } from "./log.js";

// エラー
export { Tn5250Error, type ErrorCode } from "./errors.js";

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
export { NetPrintConnection, type NetPrintConnectOptions } from "./hostserver/spool/netprint-connection.js";
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
