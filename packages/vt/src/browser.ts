/**
 * ブラウザ向けの入口。**`node:net` / `node:tls` を巻き込まない**。
 *
 * root（`@ts5250/vt`）は `transport/tcp.ts` を通じて Node の API を持つので、
 * web-ui からは**必ずこちらを import する**（`tn5250` / `tn3270` と同じ作法。AGENTS.md）。
 *
 * 画面の組み立てと打鍵の符号化はブラウザ側でも要る——サーバーが中継する構成でも、
 * 「打鍵をバイト列にする」のはブラウザでやった方が往復が減る。
 */
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
