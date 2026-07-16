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
export { terminalTypeFor, isDbcsCcsid, deviceEnvFor, type DeviceEnv } from "./session/terminal-type.js";

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
