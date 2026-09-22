import { describe, it, expect } from "vitest";
import { isKatakana290InvalidChar } from "../src/katakana.js";

/**
 * **ACS の「Katakana」（290）だけが拒否する 8 字**（`20260922-katakana-variant-setting`）。
 * 実測は `scripts/acs-probe/ccsid290-invalid-chars.txt`（社内機・ACS のコア）。
 */
describe("isKatakana290InvalidChar", () => {
  it("8 字はすべて真", () => {
    for (const ch of ["[", "]", "^", "`", "{", "}", "~", "¢"]) expect(isKatakana290InvalidChar(ch), ch).toBe(true);
  });

  it("8 字ちょうど（採取漏れ・過剰の検出）", () => {
    const hits = [..."[]^`{}~¢"].filter((ch) => isKatakana290InvalidChar(ch));
    expect(hits).toHaveLength(8);
  });

  it("それ以外の記号・英数字・全角は偽", () => {
    for (const ch of ["a", "A", "0", " ", "!", "@", "#", "あ", "ｱ", "-", "="]) {
      expect(isKatakana290InvalidChar(ch), ch).toBe(false);
    }
  });
});
