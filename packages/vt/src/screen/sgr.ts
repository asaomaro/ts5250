import type { VtParam } from "../protocol/parser.js";
import { DEFAULT_COLOR, type VtColor, type VtStyle } from "./types.js";

/**
 * **`SGR`（見た目の指定）を 1 つの `VtStyle` に畳む。**
 *
 * `SGR` は 1 つの列に複数の指定が並ぶ（`ESC[1;31;4m`）。ここは純関数で、
 * 「今の見た目」＋「パラメータ列」→「新しい見た目」を返す。
 *
 * ## 落とし穴
 *
 * - **個別解除を実装する。** `22`(太字/淡色) `23`(斜体) `24`(下線) `25`(点滅) `27`(反転)
 *   `28`(隠蔽) `29`(取り消し線)。実機の `vi` が `27m 23m 29m` を並べて出してくる
 *   （research 2.1）ので、`0` の全解除だけでは足りない
 * - **`38` / `48` の引数はセミコロン形とコロン形の両方がある。**
 *   `38;5;n` / `38;2;r;g;b`（旧来）と `38:5:n` / `38:2::r:g:b`（ITU T.416 由来）。
 *   コロン形はパーサが配列にして渡してくる
 * - **明色（90-97 / 100-107）は 8-15 の indexed に写す。** `bold` と混ぜない
 *   （`SGR 1` は太字であって色ではない。混ぜると太字を消したときに色まで戻る）
 */
export function applySgr(style: VtStyle, params: readonly VtParam[]): VtStyle {
  if (params.length === 0) return { ...style, ...RESET };
  let next = style;
  for (let i = 0; i < params.length; i++) {
    const p = params[i];
    if (isGroup(p)) {
      // コロン形: [38, 5, n] / [38, 2, undefined?, r, g, b]
      const applied = colorFromColonForm(p);
      if (applied !== undefined) {
        next = applied.isBg ? { ...next, bg: applied.color } : { ...next, fg: applied.color };
      }
      continue;
    }
    const n = p ?? 0;
    if (n === 38 || n === 48) {
      // セミコロン形は後続のパラメータを食う
      const eaten = colorFromSemicolonForm(params, i);
      if (eaten !== undefined) {
        next = n === 48 ? { ...next, bg: eaten.color } : { ...next, fg: eaten.color };
        i = eaten.nextIndex;
      }
      continue;
    }
    next = single(next, n);
  }
  return next;
}

const RESET = {
  fg: DEFAULT_COLOR,
  bg: DEFAULT_COLOR,
  bold: false,
  dim: false,
  italic: false,
  underline: false,
  blink: false,
  reverse: false,
  hidden: false,
  strike: false
} as const;

function single(s: VtStyle, n: number): VtStyle {
  switch (n) {
    case 0: return { ...s, ...RESET };
    case 1: return { ...s, bold: true };
    case 2: return { ...s, dim: true };
    case 3: return { ...s, italic: true };
    case 4: return { ...s, underline: true };
    case 5: case 6: return { ...s, blink: true };
    case 7: return { ...s, reverse: true };
    case 8: return { ...s, hidden: true };
    case 9: return { ...s, strike: true };
    // **個別解除**（22 は太字と淡色の両方を落とす。規格どおり）
    case 21: return { ...s, bold: false };
    case 22: return { ...s, bold: false, dim: false };
    case 23: return { ...s, italic: false };
    case 24: return { ...s, underline: false };
    case 25: return { ...s, blink: false };
    case 27: return { ...s, reverse: false };
    case 28: return { ...s, hidden: false };
    case 29: return { ...s, strike: false };
    case 39: return { ...s, fg: DEFAULT_COLOR };
    case 49: return { ...s, bg: DEFAULT_COLOR };
    default: break;
  }
  if (n >= 30 && n <= 37) return { ...s, fg: { kind: "indexed", index: n - 30 } };
  if (n >= 40 && n <= 47) return { ...s, bg: { kind: "indexed", index: n - 40 } };
  // 明色。**8-15 の indexed に写す**（bold と混ぜない）
  if (n >= 90 && n <= 97) return { ...s, fg: { kind: "indexed", index: n - 90 + 8 } };
  if (n >= 100 && n <= 107) return { ...s, bg: { kind: "indexed", index: n - 100 + 8 } };
  return s;
}

/** `Array.isArray` は `readonly` 配列を絞れないので自前で判定する */
function isGroup(p: VtParam): p is readonly (number | undefined)[] {
  return typeof p === "object" && p !== null;
}

interface ColorPick {
  color: VtColor;
  isBg: boolean;
}

function colorFromColonForm(parts: readonly (number | undefined)[]): ColorPick | undefined {
  const lead = parts[0];
  if (lead !== 38 && lead !== 48) return undefined;
  const isBg = lead === 48;
  const kind = parts[1];
  if (kind === 5) {
    const idx = parts[2];
    return idx === undefined ? undefined : { color: indexed(idx), isBg };
  }
  if (kind === 2) {
    // `38:2::r:g:b`（色空間の欄が空）と `38:2:r:g:b` の両方が実在する
    const rest = parts.slice(2).filter((x) => x !== undefined);
    const [r, g, b] = rest.length >= 4 ? rest.slice(1) : rest;
    if (r === undefined || g === undefined || b === undefined) return undefined;
    return { color: rgb(r, g, b), isBg };
  }
  return undefined;
}

function colorFromSemicolonForm(
  params: readonly VtParam[],
  at: number
): { color: VtColor; nextIndex: number } | undefined {
  const kind = params[at + 1];
  if (kind === 5) {
    const idx = params[at + 2];
    if (typeof idx !== "number") return undefined;
    return { color: indexed(idx), nextIndex: at + 2 };
  }
  if (kind === 2) {
    const r = params[at + 2];
    const g = params[at + 3];
    const b = params[at + 4];
    if (typeof r !== "number" || typeof g !== "number" || typeof b !== "number") return undefined;
    return { color: rgb(r, g, b), nextIndex: at + 4 };
  }
  return undefined;
}

const clamp255 = (v: number): number => (v < 0 ? 0 : v > 255 ? 255 : Math.round(v));
const indexed = (index: number): VtColor => ({ kind: "indexed", index: clamp255(index) });
const rgb = (r: number, g: number, b: number): VtColor => ({
  kind: "rgb",
  r: clamp255(r),
  g: clamp255(g),
  b: clamp255(b)
});
