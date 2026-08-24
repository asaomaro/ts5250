import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * **縦に並んだ反転（背景色）の間に地色の隙間を作らない。**
 *
 * 行間（line-height の余白）は文字要素の背景では塗られない——CSS の仕様で、半行送りぶんが
 * 地色のまま透ける。1 行だけの反転なら気付かないが、ロゴのように反転が複数行続く画面では
 * 行と行の間に地色が**横線として並んで**見える。ACS は隙間なく繋がって見えるので、
 * `.a-reverse` は box-shadow で上下へ半行送りぶん同じ色を延ばしている。
 *
 * **延ばす量は `.grid` の line-height と対**（半行送り＝(line-height - 1) / 2）。
 * 片方だけ変えると隙間が戻る（大きすぎれば隣の行へはみ出す）ので、両方をここで突き合わせる。
 * 実画素での確認は `scripts/verify-browser-reverse-rows.mjs`（jsdom は描画しない）。
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

/** `.a-reverse { … }` の宣言ブロック（コメントは先に落とす） */
function reverseBlock(): string {
  const stripped = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const m = /\.a-reverse\s*\{([^}]*)\}/.exec(stripped);
  expect(m, ".a-reverse の定義が無い").not.toBeNull();
  return m![1]!;
}

describe("縦に並んだ反転は隙間なく繋がる", () => {
  it(".a-reverse は上下へ半行送りぶん背景を延ばす", () => {
    // `.grid` の line-height（重ねものの座標計算もこの値を前提にしている）
    const lineHeight = Number(/\.grid\s*\{[^}]*line-height:\s*([\d.]+)/.exec(grid)?.[1]);
    expect(lineHeight).toBe(1.25);
    const halfLeading = (lineHeight - 1) / 2; // 0.125em

    const shadow = /box-shadow:\s*([^;]*)/.exec(reverseBlock())?.[1] ?? "";
    expect(shadow, ".a-reverse に box-shadow が無い（行間の隙間が戻る）").not.toBe("");
    // 上下 2 本とも**背景と同じ変数**で延ばす（別の色だと隙間だけ色が違って見える）
    expect(shadow).toContain(`0 ${halfLeading}em 0 0 var(--cell-bg)`);
    expect(shadow).toContain(`0 -${halfLeading}em 0 0 var(--cell-bg)`);
  });

  it("延ばすのは描画だけ（レイアウトを動かさない）", () => {
    const body = reverseBlock();
    // padding / margin / border で埋めるとセルの寸法が変わり、桁・行で置く重ねもの
    // （カーソル・罫線・窓）とずれる。box-shadow ならレイアウトに影響しない。
    for (const prop of ["padding", "margin", "border", "height", "line-height"]) {
      expect(body, `.a-reverse が ${prop} を宣言している（桁・行がずれる）`).not.toMatch(
        new RegExp(`(^|;)\\s*${prop}\\s*:`)
      );
    }
  });
});
