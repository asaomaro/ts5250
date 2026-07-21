import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * グローバルのフォーム部品スタイルが、5250 の入力欄（.grid-input）に届いてはいけない。
 *
 * `input[type="text"]` は詳細度 (0,1,1)。属性色のクラス `.c-green` は (0,1,0) なので、
 * 除外しないとホストが送った色を潰す（実際に緑の入力欄が白く描かれていた）。
 * 角丸が下線の端に出ていたのも同じ理由。
 *
 * 計算後の色は jsdom では検証できないため、**セレクタの形**で守る。
 */
// vitest の cwd はリポジトリルートのこともあるので、両方を試す
const CANDIDATES = ["packages/web-ui/src/styles.css", "src/styles.css"];
const css = CANDIDATES.map((p) => {
  try {
    return readFileSync(resolve(process.cwd(), p), "utf8");
  } catch {
    return undefined;
  }
}).find((c): c is string => c !== undefined)!;

describe("グローバルの input スタイルは 5250 の入力欄に届かない", () => {
  it("input/select のセレクタはすべて .grid-input を除外している", () => {
    // `input` または `select` で始まるセレクタを集める（.grid-input 自身の定義は無い）
    const selectors = css
      .split("}")
      .map((block) => block.split("{")[0] ?? "")
      .flatMap((s) => s.split(","))
      .map((s) => s.trim())
      .filter((s) => /^(input|select)\b/.test(s));

    expect(selectors.length).toBeGreaterThan(0);
    for (const sel of selectors) {
      expect(sel, `${sel} が .grid-input を除外していない`).toContain(":not(.grid-input)");
    }
  });
});

/**
 * `.grid-input` は scoped スタイル（詳細度 0,2,0）なので、属性クラス `.c-green` / `.a-reverse`
 * （0,1,0）に必ず勝つ。**ここで color / background を直に宣言すると、ホストが送った色と反転を潰す。**
 * 実際に「入力欄が緑ではなく白」「SEU のエラー行の反転が消える」の 2 件がこれで起きた。
 * 背景はブラウザ既定を消す必要があるので、属性側が渡す `--cell-bg` を経由すること。
 */
const GRID = CANDIDATES.map((p) => p.replace("styles.css", "components/ScreenGrid.vue"))
  .map((p) => {
    try {
      return readFileSync(resolve(process.cwd(), p), "utf8");
    } catch {
      return undefined;
    }
  })
  .find((c): c is string => c !== undefined)!;

/** `.grid-input…{ … }` の宣言ブロックを集める */
function gridInputBlocks(): { selector: string; body: string }[] {
  const out: { selector: string; body: string }[] = [];
  const re = /(\.grid-input[^{}]*)\{([^}]*)\}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(GRID))) out.push({ selector: m[1]!.trim(), body: m[2]! });
  return out;
}

describe(".grid-input は属性クラスの見た目を奪わない", () => {
  it("color を宣言しない（属性色 .c-* に決めさせる）", () => {
    for (const { selector, body } of gridInputBlocks()) {
      // **例外: `.grid-input.has-overlay`** は色替えのある欄。色は重ねた color オーバーレイが
      // 表現し、input のテキストは透明にする（属性色を奪うのではなく委譲する）。ここだけ color を許す。
      if (selector.includes(".has-overlay")) continue;
      const decls = body.split(";").map((d) => d.trim());
      const color = decls.find((d) => /^color\s*:/.test(d));
      expect(color, `${selector} が color を宣言している`).toBeUndefined();
    }
  });

  it("background は --cell-bg 経由でのみ指定する（.a-reverse を潰さない）", () => {
    const blocks = gridInputBlocks().filter(({ body }) => /(^|;)\s*background\s*:/.test(body));
    expect(blocks.length).toBeGreaterThan(0);
    for (const { selector, body } of blocks) {
      const value = /(?:^|;)\s*background\s*:([^;]*)/.exec(body)![1]!;
      expect(value, `${selector} の background が --cell-bg を経由していない`).toContain("--cell-bg");
    }
  });
});
