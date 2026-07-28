import { describe, it, expect, afterEach } from "vitest";
import {
  screenFontStack,
  sanitizeFamily,
  isLegacyId,
  listInstalledFonts,
  screenFontLabel
} from "../src/composables/screenFonts.js";

/**
 * 画面フォントの選択。**インストール済みフォントのファミリー名を設定値にする**。
 *
 * 経緯: 選べるのが定義済みの一覧だけで、しかも「導入済み判定」で選択を塞いでいたため、
 * フォントを入れても選べないことがあった。一覧を廃してインストール済みから選ぶ形にし、
 * 旧一覧の id は**過去の保存値を解決するためだけ**に残してある。
 */
describe("screenFontStack", () => {
  it("system は上書きしない（既定スタックのまま）", () => {
    expect(screenFontStack("system")).toBe("");
  });

  it("旧一覧の id（過去の保存値）は版名を束ねたスタックに解決される", () => {
    const s = screenFontStack("hackgen");
    expect(s).toContain('"HackGen Console NF"');
    expect(s).toContain('"HackGen35"'); // 35 版も含む（版名ちがいの取りこぼし防止）
    expect(s.endsWith("var(--screen-mono-stack)")).toBe(true);
  });

  it("ファミリー名はそのまま前置される（インストール済みから選んだ／名前で指定した）", () => {
    expect(screenFontStack("Meiryo")).toBe('"Meiryo", var(--screen-mono-stack)');
  });

  it("空文字は上書きしない", () => {
    expect(screenFontStack("")).toBe("");
  });

  /**
   * 設定値は localStorage 由来＝書き換えられうる。`--screen-mono` はインライン style へ
   * 流し込むので、引用符や `;` をそのまま通すと別プロパティを注入できてしまう。
   */
  it("CSS を壊す文字は落ちる（インライン style への注入を防ぐ）", () => {
    const s = screenFontStack('a"; background:url(x); font-family:"b');
    const family = s.slice(0, s.indexOf(", var("));
    expect(family).toBe('"a backgroundurlx font-familyb"'); // 記号は全部落ち、引用符は前後だけ
    expect(s).toBe(`${family}, var(--screen-mono-stack)`); // 末尾は必ず既定スタック
  });
});

describe("sanitizeFamily", () => {
  it("前後の空白を落とし、連続空白を 1 つに畳む", () => {
    expect(sanitizeFamily("  BIZ   UDGothic  ")).toBe("BIZ UDGothic");
  });
  it("日本語のフォント名はそのまま通る", () => {
    expect(sanitizeFamily("ＭＳ ゴシック")).toBe("ＭＳ ゴシック");
  });
  it("長すぎる名前は切る（フォント名として現実的な長さに収める）", () => {
    expect(sanitizeFamily("x".repeat(200)).length).toBe(64);
  });
  it("記号だけの入力は空になる（＝設定しても既定スタックのまま）", () => {
    expect(sanitizeFamily(';{}"')).toBe("");
  });
});

describe("isLegacyId", () => {
  it("旧一覧の id を見分ける（ファミリー名として解決してはいけないもの）", () => {
    expect(isLegacyId("hackgen")).toBe(true);
    expect(isLegacyId("system")).toBe(true);
    expect(isLegacyId("Meiryo")).toBe(false);
  });
});

describe("screenFontLabel", () => {
  it("旧 id はラベル（「指定中」に id を生で出さない）、ファミリー名はその名前", () => {
    expect(screenFontLabel("hackgen")).toBe("白源 HackGen");
    expect(screenFontLabel("Meiryo")).toBe("Meiryo");
  });
});

type LocalFont = { family: string; fullName?: string; postscriptName?: string };
function stubLocalFonts(fonts: LocalFont[] | Error): void {
  (globalThis as Record<string, unknown>).queryLocalFonts = () =>
    fonts instanceof Error ? Promise.reject(fonts) : Promise.resolve(fonts);
}
afterEach(() => {
  delete (globalThis as Record<string, unknown>).queryLocalFonts;
});

describe("listInstalledFonts", () => {
  it("スタイルごとの重複をファミリー単位に畳んで並べる", async () => {
    stubLocalFonts([
      { family: "Meiryo", fullName: "Meiryo Bold" },
      { family: "Meiryo", fullName: "Meiryo" },
      { family: "Arial", fullName: "Arial" }
    ]);
    expect((await listInstalledFonts())?.map((f) => f.family)).toEqual(["Arial", "Meiryo"]);
  });

  /** 一覧を出せないのは異常ではない（Firefox/Safari・権限拒否）。名前の直接入力へ倒す。 */
  it("Local Font Access が無ければ null（一覧は出せないが指定はできる）", async () => {
    expect(await listInstalledFonts()).toBeNull();
  });

  it("権限拒否（例外）でも落ちず null になる", async () => {
    stubLocalFonts(new Error("denied"));
    expect(await listInstalledFonts()).toBeNull();
  });
});
