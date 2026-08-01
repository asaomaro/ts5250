// @as400web/tn5250 公開 API

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

// 純 DBCS（GRAPHIC 列用）
export {
  PureDbcsCodec,
  pureDbcsCodecForCcsid,
  isPureDbcsCcsid,
  ibm16684,
  ibm300
} from "@as400web/ebcdic";

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

export { assertIdentifier, isValidIdentifier, IDENTIFIER_PATTERN } from "@as400web/base";

// 画面 → 自己完結 HTML（エビデンス出力）
export {
  renderScreenHtml,
  renderScreenHistoryHtml,
  type ScreenHtmlMeta,
  type ScreenHistoryEntry
} from "./screen-html.js";

