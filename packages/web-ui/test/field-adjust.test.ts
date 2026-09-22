import { describe, it, expect } from "vitest";
import {
  initEdit,
  editValue,
  eraseToEnd,
  rightAdjust,
  applyAdjust,
  fieldExit,
  type AdjustSpec
} from "../src/composables/fieldEdit.js";

/**
 * 期待値の根拠は **ACS `PS5250.performRightAdjustFill`**（空きは欄末尾から続く NUL の数だけ）と、実機の ACS のコアの測定
 * （`scripts/acs-probe/empty-adjust-field-exit.txt`。空の欄・手前が空白・打った空白）。
 * ~~GNU tn5250 `tn5250_display_shift_right` の移植を根拠にしていた（`.aidev/works/20260729-field-adjust-local-edit-keys/research.md`）~~ は、
 * 空の欄で何もせず打った末尾の空白を捨てる点が ACS と違った（節目 11 の独立点検 B-S6）。
 */

const RZ: AdjustSpec = { adjust: "right-zero" };
const RB: AdjustSpec = { adjust: "right-blank" };
const MF: AdjustSpec = { adjust: "mandatory-fill" };
const NONE: AdjustSpec = {};
const SIGNED: AdjustSpec = { signedNumeric: true };

describe("eraseToEnd（Erase EOF の中身）", () => {
  it("カーソル以降だけを空白にし、カーソルは動かさない", () => {
    const s = eraseToEnd(initEdit("ABCDE", 5, 2));
    expect(editValue(s)).toBe("AB   ");
    expect(s.cursor).toBe(2);
  });

  it("カーソルが先頭なら欄全体が消える", () => {
    expect(editValue(eraseToEnd(initEdit("ABCDE", 5, 0)))).toBe("     ");
  });

  it("カーソルが末尾なら何も消えない", () => {
    expect(editValue(eraseToEnd(initEdit("ABCDE", 5, 5)))).toBe("ABCDE");
  });
});

describe("rightAdjust（ACS `performRightAdjustFill`。空きはカーソル以降＝消したばかりの桁だけ）", () => {
  it("末尾まで空きを詰めて右へ寄せ、先頭を fill で埋める", () => {
    expect(editValue(rightAdjust(initEdit("12", 6, 2), "0"))).toBe("000012");
    expect(editValue(rightAdjust(initEdit("12", 6, 2), " "))).toBe("    12");
  });

  it("末尾が既に非空白なら 1 桁も動かさない（満杯の欄は無変化）", () => {
    expect(editValue(rightAdjust(initEdit("123456", 6, 6), "0"))).toBe("123456");
  });

  it("**何も打たずに欄の先頭で Field Exit した欄は、全桁が埋め字になる**（実機の ACS のコア: `CHECK(RZ)` の空の欄が `000000`、ホストが受け取った値も `000000`）", () => {
    expect(editValue(rightAdjust(initEdit("", 6, 0), "0"))).toBe("000000");
    expect(editValue(rightAdjust(initEdit("", 6, 0), " "))).toBe("      ");
  });

  it("**空の欄の途中で Field Exit すると、手前の空白は内容として右へ動く**（実機の ACS: 5 桁目で `00    `・2 桁目で `00000 `）", () => {
    expect(editValue(rightAdjust(initEdit("", 6, 4), "0"))).toBe("00    ");
    expect(editValue(rightAdjust(initEdit("", 6, 1), "0"))).toBe("00000 ");
  });

  it("**打った空白は空きとして捨てず、内容として一緒に動く**（実機の ACS: `1` と空白を打って `00001 `。ホストが受け取った値も `00001 `）", () => {
    expect(editValue(rightAdjust(initEdit("1 ", 6, 2), "0"))).toBe("00001 ");
  });

  it("語中の空白は保持したまま一緒に右へ動く", () => {
    expect(editValue(rightAdjust(initEdit("1 2", 6, 3), "0"))).toBe("0001 2");
  });

  it("先頭の空白も内容なので埋め字へは替えない（ACS に『先頭の空白を fill へ置換』の段は無い）", () => {
    expect(editValue(rightAdjust(initEdit("  12", 6, 4), "0"))).toBe("00  12");
  });

  it("keepLastPosition は最終桁（符号桁）を動かさず、空きにも数えない", () => {
    // 6 桁 + 符号桁の計 7 桁。数字は 0..5 に右詰めされ、最終桁は空白のまま
    const s = rightAdjust(initEdit("12", 7, 2), " ", { keepLastPosition: true });
    expect(editValue(s)).toBe("    12 ");
    // 何も打たない符号付きの欄: 手前の 6 桁だけが埋め字。符号桁は触らない
    expect(editValue(rightAdjust(initEdit("", 7, 0), "0", { keepLastPosition: true }))).toBe("000000 ");
  });

  it("カーソルが符号桁にあるときは空きが無く、何も動かさない", () => {
    expect(editValue(rightAdjust(initEdit("123456", 7, 6), "0", { keepLastPosition: true }))).toBe("123456 ");
  });

  it("右寄せ後のカーソルは欄末尾へ", () => {
    expect(rightAdjust(initEdit("12", 6, 2), "0").cursor).toBe(6);
  });
});

describe("applyAdjust（FFW 指定 → 右寄せ規則）", () => {
  it("right-zero はゼロ埋め・right-blank は空白埋め", () => {
    expect(editValue(applyAdjust(initEdit("12", 6, 2), RZ))).toBe("000012");
    expect(editValue(applyAdjust(initEdit("12", 6, 2), RB))).toBe("    12");
  });

  it("mandatory-fill は桁を動かさない（右寄せではなく充填の検証指定）", () => {
    expect(editValue(applyAdjust(initEdit("12", 6, 2), MF))).toBe("12    ");
  });

  it("ADJUST 無指定は何もしない", () => {
    expect(editValue(applyAdjust(initEdit("12", 6, 2), NONE))).toBe("12    ");
  });

  it("signed-num は ADJUST 無指定でも空白右寄せし、符号桁を残す", () => {
    expect(editValue(applyAdjust(initEdit("12", 7, 2), SIGNED))).toBe("    12 ");
  });

  /**
   * **符号付き数値でも、RZ・RB の指定は埋め字を上書きする**（ACS `performRightAdjustFill`。`20260921-signed-rz-fill`）。
   * ~~signed-num は ADJUST 指定より優先される（tn5250 どおり無条件で空白右寄せ）~~ は ACS と違った——実機の ACS のコアで
   * `CHECK(RZ) 6 0` に `12` → Field− が `000012-`（`scripts/acs-probe/field-minus-numeric-only.txt` の M1）。符号桁は動かさない。
   */
  it("signed-num でも RZ は '0' 埋め・RB は空白埋め。符号桁は動かさない", () => {
    expect(editValue(applyAdjust(initEdit("12", 7, 2), { adjust: "right-zero", signedNumeric: true }))).toBe("000012 ");
    expect(editValue(applyAdjust(initEdit("12", 7, 2), { adjust: "right-blank", signedNumeric: true }))).toBe("    12 ");
  });

  it("signed-num ＋ mandatory-fill は、調整の指定が無いのと同じ（空白右寄せ）", () => {
    expect(editValue(applyAdjust(initEdit("12", 7, 2), { adjust: "mandatory-fill", signedNumeric: true }))).toBe("    12 ");
  });
});

describe("fieldExit（消去 → 右寄せ）", () => {
  it("カーソル以降を消してから右寄せする", () => {
    // "12XX  " のカーソル 2 で Field Exit → "XX" が消えて "000012"
    expect(editValue(fieldExit(initEdit("12XX", 6, 2), RZ))).toBe("000012");
  });

  it("**消した結果が空欄でも整形する**（先頭で Field Exit すると全桁が埋め字。実機の ACS のコア）", () => {
    expect(editValue(fieldExit(initEdit("ABC", 6, 0), RZ))).toBe("000000");
    expect(editValue(fieldExit(initEdit("ABC", 6, 0), RB))).toBe("      ");
  });

  it("**符号付き数値の `CHECK(RZ)` を空のまま Field Exit すると `000000`**（符号桁は空白。実機の ACS のコア: 数値の欄も Erase EOF のあと Field Exit で `000000`）", () => {
    expect(editValue(fieldExit(initEdit("", 7, 0), { adjust: "right-zero", signedNumeric: true }))).toBe("000000 ");
  });

  it("指定が無い符号付き数値の欄は、空のまま Field Exit しても空白のまま", () => {
    expect(editValue(fieldExit(initEdit("", 7, 0), SIGNED))).toBe("       ");
  });

  it("ADJUST 指定が無ければ消去だけを行う", () => {
    expect(editValue(fieldExit(initEdit("12XX", 6, 2), NONE))).toBe("12    ");
  });
});
