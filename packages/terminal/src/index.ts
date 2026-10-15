/**
 * `@ts5250/terminal` — 5250 を文字端末で操作する前面。
 * **`export *` は使わない**（AGENTS.md）。接続・画面モデルは `@ts5250/tn5250`、ここは表示と制御だけ。
 */
export { renderFrame, paintDiff, sgrOf, type Frame, type FrameOptions, type ColorMode, type SgrExtra } from "./render/frame.js";
export {
  DEFAULT_VIEW, PLAIN_VIEW, toggleView, resolveSbcsView, recodeByte, cursorSequence, headerText, viewNote,
  type TermView, type SosiMode, type KanaMode, type CursorShape, type RuleStyle, type SbcsView
} from "./app/view.js";
export { KeyDecoder, type KeyEvent, type KeyName } from "./input/decode.js";
export { TerminalController, PREFIX_DEFAULT, type SessionLike, type ControllerOptions } from "./app/controller.js";
export { runTerminal, colorMode, type TerminalSource, type RunOptions } from "./transport/run.js";
export { WsSession, type WsOpenSpec } from "./transport/ws-session.js";
export { overlayField } from "./app/overlay.js";
