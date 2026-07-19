import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * 入力欄の下線は**下線属性が付いた欄だけ**に引く。
 *
 * 5250 で入力欄が下線付きに見えるのは、ホストが下線属性を送っているから。
 * 「入力欄だから引く」と実装すると、非表示属性の欄に 1 桁の枠が浮き出る
 * （SEU の F1 ヘルプ画面で実際に起きた。ACS はそこに何も描かない）。
 *
 * jsdom では算出スタイルを取れないため、**宣言の置き場所**で守る。
 */
const CANDIDATES = [
  "packages/web-ui/src/components/ScreenGrid.vue",
  "src/components/ScreenGrid.vue"
];
const src = CANDIDATES.map((p) => {
  try {
    return readFileSync(resolve(process.cwd(), p), "utf8");
  } catch {
    return undefined;
  }
}).find((c): c is string => c !== undefined)!;

/** `<セレクタ> { <本文> }` を全部拾う */
function rules(): { selector: string; body: string }[] {
  const out: { selector: string; body: string }[] = [];
  for (const m of src.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    out.push({ selector: m[1]!.trim(), body: m[2]! });
  }
  return out;
}

describe("入力欄の下線は下線属性に従う", () => {
  it(".grid-input 単体では border-bottom を引かない", () => {
    const plain = rules().filter((r) => /(^|\s|,)\.grid-input$/.test(r.selector));
    expect(plain.length, ".grid-input の定義が見つからない").toBeGreaterThan(0);
    for (const r of plain) {
      expect(r.body, `${r.selector} が無条件に下線を引いている`).not.toMatch(/border-bottom\s*:/);
    }
  });

  it(".grid-input.a-underline が下線を引く", () => {
    const underlined = rules().find((r) => r.selector.includes(".grid-input.a-underline"));
    expect(underlined, ".grid-input.a-underline の定義が無い").toBeDefined();
    expect(underlined!.body).toMatch(/border-bottom\s*:\s*1px solid/);
  });
});
