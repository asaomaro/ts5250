/**
 * `@ts5250/vt` — VT / xterm の文字モード端末。
 *
 * **`export *` は使わない**（AGENTS.md）。何が外に出ているかを目視できる形に保つ。
 *
 * ブラウザから使うときは **`@ts5250/vt/browser`** を import すること——
 * こちらの入口は `transport/tcp.ts` 経由で `node:net` / `node:tls` を巻き込む。
 */
export { VtSession, type VtSessionOptions, type VtSessionEvents } from "./session/vt-session.js";
export { TcpTransport, type TcpConnectOptions } from "./transport/tcp.js";
export { VtTelnet, type VtTelnetOptions } from "./telnet/telnet.js";
export type { Transport } from "./transport/types.js";
export { Trace, traced, toHex, fromHex, type TraceEntry } from "./trace/trace.js";
export { ReplayTransport } from "./trace/replay.js";

// ブラウザでも使う部分（`browser.ts` と同じものを出す）
export {
  VtParser,
  parseParams,
  type VtEvent,
  type VtParam,
  type VtParserOptions
} from "./protocol/parser.js";
export { VtTerminal } from "./screen/terminal.js";
export { VtBuffer } from "./screen/buffer.js";
export {
  DEFAULT_STYLE,
  DEFAULT_COLOR,
  blankCell,
  type VtCell,
  type VtColor,
  type VtStyle,
  type VtSnapshot
} from "./screen/types.js";
export { defaultModes, type VtModes, type MouseMode, type MouseEncoding } from "./screen/modes.js";
export { applySgr } from "./screen/sgr.js";
export { charsetFor, mapChar, type CharsetId } from "./screen/charset.js";
export {
  encodeKey,
  encodePaste,
  encodeMouse,
  type VtKeyEvent,
  type VtKeyName,
  type VtMouseEvent,
  type VtMouseButton
} from "./input/keys.js";
export {
  VtDecoder,
  encodeText,
  isVtEncoding,
  reverseTableSize,
  VT_ENCODINGS,
  type VtEncoding,
  type EncodeResult
} from "./text/codec.js";
