/**
 * **DEC 特殊図形集合**（`ESC ( 0` で G0 に指定される）。罫線を引くのに今も使われる——
 * `tmux` の枠線、`mc` の枠、`less` の一部がこれで描く。
 *
 * 対応表は DEC の VT100 技術資料の割り当てそのもの（0x5F-0x7E の 32 文字）。
 * ここに無い符号位置は**そのまま通す**（ASCII として扱う）。
 */
const DEC_SPECIAL: Readonly<Record<string, string>> = {
  "_": " ",       // 0x5F 空白
  "`": "◆",  // ◆
  a: "▒",    // ▒
  b: "␉",    // HT
  c: "␌",    // FF
  d: "␍",    // CR
  e: "␊",    // LF
  f: "°",    // °
  g: "±",    // ±
  h: "␤",    // NL
  i: "␋",    // VT
  j: "┘",    // ┘
  k: "┐",    // ┐
  l: "┌",    // ┌
  m: "└",    // └
  n: "┼",    // ┼
  o: "⎺",    // ⎺
  p: "⎻",    // ⎻
  q: "─",    // ─
  r: "⎼",    // ⎼
  s: "⎽",    // ⎽
  t: "├",    // ├
  u: "┤",    // ┤
  v: "┴",    // ┴
  w: "┬",    // ┬
  x: "│",    // │
  y: "≤",    // ≤
  z: "≥",    // ≥
  "{": "π",  // π
  "|": "≠",  // ≠
  "}": "£",  // £
  "~": "·"   // ·
};

/** 文字集合の指定（`ESC ( <final>` の終端バイト） */
export type CharsetId = "ascii" | "dec-special" | "uk" | "other";

export function charsetFor(final: string): CharsetId {
  if (final === "0") return "dec-special";
  if (final === "A") return "uk";
  if (final === "B") return "ascii";
  return "other";
}

/** 指定中の文字集合で 1 文字を写す */
export function mapChar(ch: string, cs: CharsetId): string {
  if (cs === "dec-special") return DEC_SPECIAL[ch] ?? ch;
  // 英国集合は `#` が `£` になるだけ（それ以外は ASCII と同じ）
  if (cs === "uk" && ch === "#") return "£";
  return ch;
}
