import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { EMBED_APP_EXTENSIONS } from "../src/protocol.js";

/**
 * `package.json`の`customEditors`/`languages`は`EMBED_APP_EXTENSIONS`と同じ拡張子を持つ（`decisions.md` D32）。
 * 静的な JSON なので表を参照できない——片方だけ直すと、その種別のファイルが開けない／種別が決まらない
 */
describe("package.json の拡張子", () => {
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
    contributes: { customEditors: { selector: { filenamePattern: string }[] }[]; languages: { extensions: string[] }[] };
  };
  const expected = Object.values(EMBED_APP_EXTENSIONS).sort();

  it("customEditors の selector が5種の拡張子と一致する", () => {
    const patterns = pkg.contributes.customEditors[0]!.selector.map((s) => s.filenamePattern.replace(/^\*/, "")).sort();
    expect(patterns).toEqual(expected);
  });

  it("languages（ファイルアイコン）の extensions が5種の拡張子と一致する", () => {
    expect([...pkg.contributes.languages[0]!.extensions].sort()).toEqual(expected);
  });
});
