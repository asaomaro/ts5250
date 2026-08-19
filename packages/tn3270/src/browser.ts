/**
 * ブラウザ向けの入口。
 *
 * **`transport/tcp.ts` を含めない**——あれは `node:net` / `node:tls` を巻き込むので、
 * root（`index.ts`）をブラウザから import してはならない（AGENTS.md）。
 * ここから出すのは純粋な型とロジックだけ。
 */
export type { Transport } from "./transport/types.js";
export { ByteReader, ByteWriter } from "./protocol/bytes.js";
export {
  terminalTypeFor,
  alternateSizeFor,
  PRIMARY_SIZE,
  ALTERNATE_SIZE,
  type Model3270,
  type TerminalFamily,
  type TerminalTypeOptions
} from "./telnet/terminal-type.js";
export {
  CMD3270,
  ORDER,
  WCC,
  ATTR,
  DISPLAY,
  XA,
  HILITE,
  COLOR,
  SO,
  SI,
  NUL
} from "./protocol/constants.js";
export {
  decodeAddress,
  encodeAddress,
  toRowCol,
  fromRowCol,
  MAX_12BIT
} from "./protocol/address.js";
export { Screen3270 } from "./screen/buffer.js";
export {
  parseFieldAttr,
  withMdt,
  colorOf,
  highlightOf,
  type FieldAttr,
  type Highlight
} from "./screen/attributes.js";
export { snapshot, type SnapshotOptions } from "./screen/snapshot.js";
export {
  applyInbound,
  type InboundResult,
  type ReadRequest,
  type UnknownItem
} from "./protocol/inbound.js";
export type { Cell, CellKind, Field, ScreenSnapshot, ScreenColor } from "./screen/types.js";
export {
  AID,
  AID_NONE,
  aidCodeOf,
  aidKeyForCode,
  isShortForm,
  type AidKey
} from "./session/aid-keys.js";
export {
  buildReadModified,
  buildReadBuffer,
  type OutboundOptions
} from "./protocol/outbound.js";
export { Emitter } from "./session/emitter.js";
export { Trace, traced, toHex, fromHex, type TraceEntry } from "./trace/trace.js";
export { ReplayTransport } from "./trace/replay.js";
