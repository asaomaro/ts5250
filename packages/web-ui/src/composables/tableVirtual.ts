import { isFullWidth } from "@ts5250/base";

/**
 * **結果表を仮想化するための計算**（`20260802-sql-table-virtualize`）。
 *
 * ここは**純粋**——DOM を触らない。触るのは `SqlResultTable.vue` 側だけで、
 * 実測（1 文字の px・行の高さ）を引数として受け取る。
 * こうしておくと、**論理は jsdom で固定でき**、実ブラウザでは
 * 「測った値が正しいか」だけを見ればよくなる。
 *
 * ## なぜ仮想化するのか
 *
 * 実ブラウザ＋実機で測った初回描画（`scripts/research-sql-table-render.mjs`）:
 *
 * | 行 × 列 | セル数 | 描画 |
 * |---|---:|---:|
 * | 200 × 40 | 8,000 | 123 ms |
 * | 1000 × 40 | 40,000 | **582 ms** |
 * | 1000 × 8 | 8,000 | 117 ms |
 *
 * **1 セルあたり ~14 µs でほぼ一定**——律速は行数でもレイアウトでもなく
 * 「セルを 1 つ作る仕事」。だから `table-layout: fixed` にするだけでは速くならず、
 * **セルを作らない**（表示範囲だけ描く）ことだけが効く。
 */

/** 全角が半角の何倍か（測れないときの既定）。**広すぎる側に倒す** */
export const FALLBACK_WIDE_WEIGHT = 2;
/** 測れないときの 1 文字ぶんの px（jsdom など）。13px の等幅のおおよそ */
export const FALLBACK_CHAR_PX = 7.2;
/** 測れないときの行の高さ（px）。`padding 5px * 2` ＋ 行 ＋ 罫線 */
export const FALLBACK_ROW_PX = 24;
/** セルの左右余白ぶん（`padding: 5px 8px` の 8px × 2 ＋ 罫線） */
export const CELL_PADDING_PX = 17;
/**
 * 列幅の上限（文字）。
 *
 * **いまは上限が無い**（`SqlResultTable` の CSS に `max-width` が無い）ので、
 * 1 セルに数千文字の CLOB が来ると**その 1 列で画面が埋まり、他の列に辿り着けない**。
 * 超えた列は切り詰めて `…` を出し、**ドラッグで広げられる**。
 * `TransferPane` は既に `max-width: 40ch` で同じ扱いなので、新しい概念ではない。
 */
export const MAX_COL_CHARS = 120;
/** 窓の前後に余分に描く行数。速いスクロールで空白が見えないための余裕 */
export const OVERSCAN_ROWS = 12;
/**
 * **測る前の 1 枚目に描く行数。**
 *
 * ビューポートの高さは**描いたあとでないと測れない**。0 を「測れない」と同じに扱うと、
 * 1 枚目で全行を描いてから間引くことになり、**仮想化前より遅くなる**
 * （実測: 1000 行で 582ms → 876ms）。1 画面ぶんに足りる固定数で始め、
 * 測ったあとに正しい窓へ差し替える。
 *
 * 900px のビューポートで行高 24px なら 38 行。余白を足しても 64 で足りる。
 */
export const INITIAL_ROWS = 64;

const NON_ASCII = /[^\x20-\x7e]/;

/**
 * **半角 1 文字を 1 とした送り幅。**
 *
 * セルは等幅（`font-family: var(--mono)`）・折り返しなし（`white-space: pre`）なので、
 * 幅は送り幅に正比例する——測らずに計算できる。
 *
 * ⚠ **全角は 2 とは限らない。** 端末の桁勘定では全角＝2 だが、ここは Web フォントの話で、
 * `IBM Plex Mono` は CJK の字形を持たず**代替フォントが描く**。実ブラウザで測ると
 * 半角 8.00px に対し全角 13.00px＝**1.625 倍**だった
 * （`scripts/verify-sql-table-virtualize.mjs` 節 7）。
 * 2 で数えると日本語の列だけ 2 割ほど広くなるので、**実測した比を渡す**。
 * 既定の 2 は測れないときの保険（**広すぎる側に倒す**——狭いと文字が切れる）。
 *
 * **ASCII だけなら `length` で済ませる**。40,000 セル × 十数文字を走るので、
 * 1 文字ずつ判定すると幅の計算のほうが描画より高くつきかねない。
 */
export function displayWidth(s: string, wideWeight = 2): number {
  // 印字可能な ASCII だけなら 1 文字 = 1 幅。**この近道が無いと幅の計算が描画より高くつく**
  if (!NON_ASCII.test(s)) return s.length;
  let w = 0;
  for (const ch of s) w += isFullWidth(ch) ? wideWeight : 1;
  return w;
}

/**
 * 列ごとの表示幅（文字）。**見出しと全行**を見る。
 *
 * **標本（先頭 N 行）にしない。** 後ろにある長い値で列が足りなくなり、
 * `table-layout: auto` の今の見え方と食い違う。文字数を数えるだけなので、
 * 全行を走っても描画より 2 桁安い。
 *
 * `cellText` は**表示に使うのと同じ関数**を渡すこと——別々に決めると、
 * LOB や NULL の列だけ幅と中身が食い違う。
 */
export function columnCharWidths<R>(
  headers: readonly string[],
  rows: readonly R[],
  cellText: (row: R, col: number) => string,
  maxChars: number = MAX_COL_CHARS,
  wideWeight = 2
): number[] {
  const widths = headers.map((h) => displayWidth(h, wideWeight));
  for (const row of rows) {
    for (let c = 0; c < headers.length; c++) {
      const w = displayWidth(cellText(row, c), wideWeight);
      if (w > widths[c]!) widths[c] = w;
    }
  }
  return widths.map((w) => Math.min(w, maxChars));
}

/** 表示幅（文字）→ 列の px */
export function charWidthToPx(chars: number, charPx: number): number {
  return Math.ceil(chars * charPx) + CELL_PADDING_PX;
}

export interface RowWindow {
  /** 描き始める行（0 起点） */
  start: number;
  /** 描き終える行の**次**（`slice(start, end)` にそのまま渡せる） */
  end: number;
}

/**
 * 描く範囲。
 *
 * 行の高さは揃っている（等幅・折り返しなし・固定フォントサイズ）ので掛け算で足りる。
 * `headerH` は **sticky な見出しのぶん**——引き忘れると窓が見出しの高さだけずれる。
 *
 * `rowH` が 0 以下（測れなかった）なら**全部描く**方へ倒す。
 * 間引きに失敗して行が消えるより、遅いほうがまし。
 */
export function visibleWindow(
  scrollTop: number,
  viewportH: number,
  rowH: number,
  total: number,
  overscan: number = OVERSCAN_ROWS,
  headerH = 0
): RowWindow {
  if (total <= 0) return { start: 0, end: 0 };
  if (!(rowH > 0) || !(viewportH > 0)) return { start: 0, end: total };
  const top = Math.max(0, scrollTop - headerH);
  const start = Math.max(0, Math.floor(top / rowH) - overscan);
  const end = Math.min(total, Math.ceil((top + viewportH) / rowH) + overscan);
  // 逆転しない（`scrollTop` が過大なときに `start > end` になるのを防ぐ）
  return { start: Math.min(start, Math.max(0, end - 1)), end };
}
