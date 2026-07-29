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
 * 期待値の根拠は **GNU tn5250 `lib5250/display.c` の `tn5250_display_shift_right`**（原典）と
 * tn5250j `Screen5250#fieldExit`。仕様の出所は `.aidev/works/20260729-field-adjust-local-edit-keys/research.md`。
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

describe("rightAdjust（原典 tn5250_display_shift_right の移植）", () => {
  it("末尾まで空白を詰めて右へ寄せ、先頭を fill で埋める", () => {
    expect(editValue(rightAdjust(initEdit("12", 6, 2), "0"))).toBe("000012");
    expect(editValue(rightAdjust(initEdit("12", 6, 2), " "))).toBe("    12");
  });

  it("末尾が既に非空白なら 1 桁も動かさない（満杯の欄は無変化）", () => {
    expect(editValue(rightAdjust(initEdit("123456", 6, 6), "0"))).toBe("123456");
  });

  it("全桁が空白の欄は整形しない（原典の無限ループ回避と同じ判定）", () => {
    expect(editValue(rightAdjust(initEdit("", 6, 0), "0"))).toBe("      ");
  });

  it("語中の空白は保持したまま一緒に右へ動く", () => {
    // 原典: 先頭の空白を fill で置換 → 末尾が非空白になるまで右シフト
    expect(editValue(rightAdjust(initEdit("1 2", 6, 3), "0"))).toBe("0001 2");
  });

  it("先頭の空白は fill へ置換されてから右詰めされる", () => {
    expect(editValue(rightAdjust(initEdit("  12", 6, 4), "0"))).toBe("000012");
  });

  it("keepLastPosition は最終桁（符号桁）を動かさない", () => {
    // 6 桁 + 符号桁の計 7 桁。数字は 0..5 に右詰めされ、最終桁は空白のまま
    const s = rightAdjust(initEdit("12", 7, 2), " ", { keepLastPosition: true });
    expect(editValue(s)).toBe("    12 ");
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

  it("signed-num は ADJUST 指定より優先される（原典どおり無条件で空白右寄せ）", () => {
    const s = applyAdjust(initEdit("12", 7, 2), { adjust: "right-zero", signedNumeric: true });
    expect(editValue(s)).toBe("    12 ");
  });
});

describe("fieldExit（消去 → 右寄せ）", () => {
  it("カーソル以降を消してから右寄せする", () => {
    // "12XX  " のカーソル 2 で Field Exit → "XX" が消えて "000012"
    expect(editValue(fieldExit(initEdit("12XX", 6, 2), RZ))).toBe("000012");
  });

  it("消した結果が空欄なら整形しない", () => {
    expect(editValue(fieldExit(initEdit("ABC", 6, 0), RZ))).toBe("      ");
  });

  it("ADJUST 指定が無ければ消去だけを行う", () => {
    expect(editValue(fieldExit(initEdit("12XX", 6, 2), NONE))).toBe("12    ");
  });
});
