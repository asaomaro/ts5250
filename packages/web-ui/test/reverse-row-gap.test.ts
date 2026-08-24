import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * **縦に並んだ反転（背景色）の間に地色の隙間を作らない／隣の行へはみ出さない。**
 *
 * 素のインライン要素は**内容領域（フォントの ascent+descent）にしか背景を塗らない**。
 * そのため反転が複数行続くと行と行の間に地色が横線として並ぶ（ACS は隙間なく繋がる）。
 *
 * **固定量を足す手（box-shadow / padding）は使わない。** 必要な量は
 * 「行送り − 内容領域」÷2 で、内容領域はフォントごとに違う——1em を前提にした固定量は、
 * 内容領域の広いフォント（例: Noto Sans Mono CJK JP は 1.4em）で**隣の行へはみ出す**
 * （実測: 行送り 18.75px に対し塗り 25px）。CSS からフォントの内容領域は読めないので、
 * **文字ランの箱そのものを行送りに合わせる**（`display:inline-block` ＋ `height` ＋
 * `vertical-align:top`）。これなら足りない／はみ出すが原理的に起きない。
 *
 * 実画素の確認は `scripts/verify-browser-reverse-rows.mjs`（塗りの高さ）と
 * `scripts/verify-cursor-align.mjs`（文字とカーソルの位置）。jsdom は描画しない。
 */
const CANDIDATES = ["packages/web-ui/src", "src"];
const read = (rel: string): string => {
  for (const base of CANDIDATES) {
    try {
      return readFileSync(resolve(process.cwd(), base, rel), "utf8");
    } catch {
      /* もう片方の cwd を試す */
    }
  }
  throw new Error(`${rel} が見つからない`);
};

const css = read("styles.css");
const grid = read("components/ScreenGrid.vue");

/**
 * 指定した選択子の宣言ブロック（コメントは先に落とす）。
 * **選択子は正規化して完全一致で探す**——部分一致だと `.half-cell` が
 * `.grid-span, .wide-cell, .half-cell` のまとめ規則に当たり、別の規則を検査してしまう。
 */
function block(source: string, selector: string): string {
  const want = selector.replace(/\s+/g, "");
  const stripped = source.replace(/\/\*[\s\S]*?\*\//g, "");
  for (const chunk of stripped.split("}")) {
    const i = chunk.indexOf("{");
    if (i < 0) continue;
    const sel = chunk.slice(0, i).replace(/\s+/g, "");
    if (sel.endsWith(want) && (sel === want || sel.slice(0, -want.length).endsWith("}"))) {
      return chunk.slice(i + 1);
    }
  }
  throw new Error(`${selector} の定義が無い`);
}

describe("縦に並んだ反転は隙間なく繋がり、隣の行へはみ出さない", () => {
  it("文字ランの箱の高さが .grid の行送りと一致する", () => {
    const lineHeight = Number(/\.grid\s*\{[^}]*line-height:\s*([\d.]+)/.exec(grid)?.[1]);
    expect(lineHeight).toBe(1.25);
    // `.grid-span,.wide-cell,.half-cell` をまとめた規則
    const runBox = block(grid, ".grid-span,.wide-cell,.half-cell");
    expect(runBox).toContain("display: inline-block");
    expect(runBox).toContain(`height: ${lineHeight}em`);
    expect(runBox).toContain("vertical-align: top"); // 箱の上端を行の上端へ揃える
  });

  it("反転は色だけを持ち、固定量で背景を広げない", () => {
    const rev = block(css, ".a-reverse");
    expect(rev).toContain("background: var(--cell-bg)");
    expect(rev).toContain("color: var(--crt)");
    // **固定量で足すのは禁止**——フォントの内容領域次第で足りない／はみ出す
    for (const prop of ["box-shadow", "padding", "margin", "border", "height", "line-height"]) {
      expect(rev, `.a-reverse が ${prop} を宣言している（フォント依存で隣の行へ出る）`).not.toMatch(
        new RegExp(`(^|;)\\s*${prop}\\s*:`)
      );
    }
  });

  it("全角の箱は行送りの箱と食い違う指定を持たない（反転がその桁だけ届かなくなる）", () => {
    for (const sel of [".wide-cell", ".half-cell"]) {
      const body = block(grid, sel);
      expect(body, `${sel} が vertical-align を上書きしている`).not.toMatch(/vertical-align\s*:/);
      expect(body, `${sel} が height を上書きしている`).not.toMatch(/(^|;)\s*height\s*:/);
    }
  });
});
