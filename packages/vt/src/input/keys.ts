import { encodeText, type VtEncoding } from "../text/codec.js";
import type { VtModes } from "../screen/modes.js";

/**
 * **打鍵をホストへ送るバイト列に落とす。**
 *
 * ブロックモード（5250 / 3270）と違い、VT では**押した瞬間に送る**。画面が変わるのは
 * ホストがエコーを返してきたときで、クライアントは自分で画面を書かない。
 *
 * ここは**純関数**にしてある——現在のモードを引数で受け取り、状態を持たない。
 * `DECCKM` / `DECKPAM` / `2004` の分岐はテストで固定したい部分そのものなので、
 * セッションの中に埋めない。
 */

/** 名前つきのキー。ここに無いものは `text` として渡す */
export type VtKeyName =
  | "Enter" | "Tab" | "Backspace" | "Escape" | "Delete" | "Insert"
  | "ArrowUp" | "ArrowDown" | "ArrowRight" | "ArrowLeft"
  | "Home" | "End" | "PageUp" | "PageDown"
  | "F1" | "F2" | "F3" | "F4" | "F5" | "F6" | "F7" | "F8" | "F9" | "F10" | "F11" | "F12"
  | "F13" | "F14" | "F15" | "F16" | "F17" | "F18" | "F19" | "F20"
  | "KeypadEnter" | "Keypad0" | "Keypad1" | "Keypad2" | "Keypad3" | "Keypad4"
  | "Keypad5" | "Keypad6" | "Keypad7" | "Keypad8" | "Keypad9"
  | "KeypadPlus" | "KeypadMinus" | "KeypadMultiply" | "KeypadDivide" | "KeypadDecimal";

export interface VtKeyEvent {
  /** 名前つきのキー（`ArrowUp` など）。文字を打つときは省いて `text` を使う */
  key?: VtKeyName;
  /** 打った文字（1 文字とは限らない——IME の確定でまとめて来る） */
  text?: string;
  ctrl?: boolean;
  alt?: boolean;
  shift?: boolean;
  /** `Backspace` が `DEL`(0x7f) ではなく `BS`(0x08) を送る端末に合わせる */
  backspaceSendsBackspace?: boolean;
}

const ESC = "\x1b";

/**
 * 修飾キーの番号（xterm の規約）。`1 + shift(1) + alt(2) + ctrl(4)`。
 * 修飾が無ければ `undefined`（＝番号を付けない短い形を使う）。
 */
function modifier(e: VtKeyEvent): number | undefined {
  const m = 1 + (e.shift === true ? 1 : 0) + (e.alt === true ? 2 : 0) + (e.ctrl === true ? 4 : 0);
  return m === 1 ? undefined : m;
}

/** `ESC [ 1 ; m <final>` / `ESC [ <n> ; m ~` の組み立て */
const csiLetter = (final: string, mod: number | undefined, appMode: boolean): string =>
  mod === undefined ? (appMode ? `${ESC}O${final}` : `${ESC}[${final}`) : `${ESC}[1;${mod}${final}`;

const csiTilde = (n: number, mod: number | undefined): string =>
  mod === undefined ? `${ESC}[${n}~` : `${ESC}[${n};${mod}~`;

/** `F5`〜`F20` の番号（xterm の割り当て。歯抜けは仕様どおり） */
const TILDE_FN: Readonly<Record<string, number>> = {
  F5: 15, F6: 17, F7: 18, F8: 19, F9: 20, F10: 21, F11: 23, F12: 24,
  F13: 25, F14: 26, F15: 28, F16: 29, F17: 31, F18: 32, F19: 33, F20: 34,
  Insert: 2, Delete: 3, PageUp: 5, PageDown: 6
};

/** キーパッド（application 様式のときだけ `ESC O <x>` を送る） */
const KEYPAD: Readonly<Record<string, [normal: string, application: string]>> = {
  Keypad0: ["0", `${ESC}Op`], Keypad1: ["1", `${ESC}Oq`], Keypad2: ["2", `${ESC}Or`],
  Keypad3: ["3", `${ESC}Os`], Keypad4: ["4", `${ESC}Ot`], Keypad5: ["5", `${ESC}Ou`],
  Keypad6: ["6", `${ESC}Ov`], Keypad7: ["7", `${ESC}Ow`], Keypad8: ["8", `${ESC}Ox`],
  Keypad9: ["9", `${ESC}Oy`], KeypadPlus: ["+", `${ESC}Ok`], KeypadMinus: ["-", `${ESC}Om`],
  KeypadMultiply: ["*", `${ESC}Oj`], KeypadDivide: ["/", `${ESC}Oo`],
  KeypadDecimal: [".", `${ESC}On`], KeypadEnter: ["\r", `${ESC}OM`]
};

/**
 * 打鍵 → バイト列。**送るものが無ければ空配列**を返す（未対応キーで例外にしない）。
 */
export function encodeKey(
  e: VtKeyEvent,
  modes: VtModes,
  encoding: VtEncoding = "utf-8"
): Uint8Array {
  const s = keyToString(e, modes);
  if (s === "") return new Uint8Array(0);
  // **制御バイトは符号化を通さない**（Shift_JIS の逆引きに ESC を渡す意味が無い）
  if (e.text === undefined) return ascii(s);
  return encodeText(s, encoding).bytes;
}

function keyToString(e: VtKeyEvent, modes: VtModes): string {
  const mod = modifier(e);
  const app = modes.applicationCursorKeys;

  if (e.key !== undefined) {
    switch (e.key) {
      case "ArrowUp": return csiLetter("A", mod, app);
      case "ArrowDown": return csiLetter("B", mod, app);
      case "ArrowRight": return csiLetter("C", mod, app);
      case "ArrowLeft": return csiLetter("D", mod, app);
      case "Home": return csiLetter("H", mod, app);
      case "End": return csiLetter("F", mod, app);
      // **F1〜F4 は `ESC O P`〜`ESC O S`**（`SS3`）。修飾つきだけ `ESC [ 1 ; m P`
      case "F1": return csiLetter("P", mod, true);
      case "F2": return csiLetter("Q", mod, true);
      case "F3": return csiLetter("R", mod, true);
      case "F4": return csiLetter("S", mod, true);
      case "Enter": return prefixAlt(e, "\r");
      case "Tab": return e.shift === true ? `${ESC}[Z` : prefixAlt(e, "\t");
      case "Backspace":
        return prefixAlt(e, e.backspaceSendsBackspace === true ? "\b" : "\x7f");
      case "Escape": return prefixAlt(e, ESC);
      default: break;
    }
    const tilde = TILDE_FN[e.key];
    if (tilde !== undefined) return csiTilde(tilde, mod);
    const pad = KEYPAD[e.key];
    if (pad !== undefined) return modes.applicationKeypad ? pad[1] : pad[0];
    return "";
  }

  const text = e.text ?? "";
  if (text === "") return "";
  if (e.ctrl === true) {
    const c = controlChar(text);
    if (c !== undefined) return prefixAlt(e, c);
  }
  return prefixAlt(e, text);
}

/** `Alt` は **ESC 前置**（xterm の `metaSendsEscape`。既定の振る舞い） */
const prefixAlt = (e: VtKeyEvent, s: string): string => (e.alt === true ? ESC + s : s);

/**
 * `Ctrl` ＋ 文字 → C0。`Ctrl+A`=0x01 … `Ctrl+Z`=0x1A、
 * `Ctrl+@`=0x00・`Ctrl+[`=0x1B・`Ctrl+\`=0x1C・`Ctrl+]`=0x1D・`Ctrl+^`=0x1E・`Ctrl+_`=0x1F。
 * **`Ctrl+Space` は NUL**（実機のシェルで補完等に使う）。
 */
function controlChar(text: string): string | undefined {
  if (text.length !== 1) return undefined;
  const ch = text.toUpperCase();
  const code = ch.charCodeAt(0);
  if (code >= 0x41 && code <= 0x5a) return String.fromCharCode(code - 0x40);
  switch (text) {
    case " ": case "@": return "\x00";
    case "[": return "\x1b";
    case "\\": return "\x1c";
    case "]": return "\x1d";
    case "^": return "\x1e";
    case "_": case "?": return "\x1f";
    default: return undefined;
  }
}

/**
 * 貼り付け。`?2004` が有効なら `ESC[200~` … `ESC[201~` で包む。
 *
 * **包むと、貼った内容がシェルの補完やエディタの自動字下げに食われない**——
 * これが bracketed paste の目的。`\r\n` は `\r` に寄せる（端末は CR を Enter として扱う）。
 */
export function encodePaste(
  text: string,
  modes: VtModes,
  encoding: VtEncoding = "utf-8"
): Uint8Array {
  const body = text.replace(/\r\n/gu, "\r").replace(/\n/gu, "\r");
  const bytes = encodeText(body, encoding).bytes;
  if (!modes.bracketedPaste) return bytes;
  const head = ascii(`${ESC}[200~`);
  const tail = ascii(`${ESC}[201~`);
  const out = new Uint8Array(head.length + bytes.length + tail.length);
  out.set(head, 0);
  out.set(bytes, head.length);
  out.set(tail, head.length + bytes.length);
  return out;
}

/** マウスのボタン */
export type VtMouseButton = "left" | "middle" | "right" | "wheelUp" | "wheelDown";

export interface VtMouseEvent {
  button: VtMouseButton;
  /** 0 起点 */
  row: number;
  col: number;
  kind: "down" | "up" | "move";
  ctrl?: boolean;
  alt?: boolean;
  shift?: boolean;
}

/**
 * マウス報告。**`?1006`（SGR 拡張）を主に使う**——旧来の x10 形式は座標を
 * `32 + n` の 1 バイトで送るので **223 桁までしか表せない**。
 *
 * 送るべきでないとき（`mouse: "off"`、`click` 中の移動など）は空を返す。
 */
export function encodeMouse(e: VtMouseEvent, modes: VtModes): Uint8Array {
  if (modes.mouse === "off") return new Uint8Array(0);
  if (e.kind === "move") {
    if (modes.mouse === "click") return new Uint8Array(0);
    if (modes.mouse === "drag" && e.button === "wheelUp") return new Uint8Array(0);
  }

  let code = BUTTON_CODE[e.button];
  if (e.kind === "move") code += 32;
  if (e.shift === true) code += 4;
  if (e.alt === true) code += 8;
  if (e.ctrl === true) code += 16;

  const row = e.row + 1;
  const col = e.col + 1;
  if (modes.mouseEncoding === "sgr") {
    return ascii(`${ESC}[<${code};${col};${row}${e.kind === "up" ? "m" : "M"}`);
  }
  // x10: 座標が 223 を超えたら表せない。**黙って化けさせずに送らない**
  if (row > 223 || col > 223) return new Uint8Array(0);
  const released = e.kind === "up" ? 3 : code;
  return Uint8Array.of(0x1b, 0x5b, 0x4d, released + 32, col + 32, row + 32);
}

const BUTTON_CODE: Readonly<Record<VtMouseButton, number>> = {
  left: 0,
  middle: 1,
  right: 2,
  wheelUp: 64,
  wheelDown: 65
};

const ascii = (s: string): Uint8Array => Uint8Array.from(s, (c) => c.charCodeAt(0) & 0xff);
