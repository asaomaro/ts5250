import { describe, it, expect } from "vitest";
import { Screen3270 } from "../src/screen/buffer.js";
import { applyInbound } from "../src/protocol/inbound.js";
import { snapshot } from "../src/screen/snapshot.js";
import { encodeAddress } from "../src/protocol/address.js";
import { CMD3270, ORDER, WCC, XA, HILITE, COLOR } from "../src/protocol/constants.js";

/**
 * **属性桁は欄の見た目を引き継がない。**
 *
 * 属性桁は 1 桁を占めるが、原典は**既定の属性**で空白として描く
 * （`c3270/screen.c` は `xattrset(defattr)` してから空白を出す）。
 *
 * 引き継ぐと、下線つきの入力欄の**手前の桁に下線が 1 つ描かれる**。
 * 実機（IBM i のサインオン）でこれが `_` として見えた——入力欄が 53 桁目から始まり、
 * 52 桁目の属性桁に下線が乗っていた。同じ画面を 5250 で受けると属性桁の下線は無く、
 * `tn5250` 側は属性桁で下線・反転・点滅を明示的に落としている。
 */
const sba = (a: number): number[] => [ORDER.SBA, ...encodeAddress(a)];

/** 下線つき・緑の入力欄を 1 つ持つ画面 */
function underlinedField(): ReturnType<typeof snapshot> {
  const s = new Screen3270(2);
  applyInbound(
    s,
    Uint8Array.from([
      CMD3270.ERASE_WRITE,
      WCC.RESTORE,
      ...sba(0),
      // SFE: 基本属性（非保護）＋ 下線 ＋ 緑
      ORDER.SFE,
      3,
      XA.BASIC,
      0x00,
      XA.HIGHLIGHT,
      HILITE.UNDERSCORE,
      XA.FOREGROUND,
      COLOR.GREEN,
      0xc1, // 'A'
      0xc2 // 'B'
    ])
  );
  return snapshot(s, 37);
}

describe("属性桁の見た目", () => {
  const snap = underlinedField();
  const attrCell = snap.cells[0]![0]!;
  const first = snap.cells[0]![1]!;

  it("属性桁であること（前提の確認）", () => {
    expect(attrCell.kind).toBe("attr");
    expect(attrCell.char).toBe(" ");
  });

  it("**欄の下線を引き継がない**（引き継ぐと入力欄の手前に `_` が出る）", () => {
    expect(first.underline, "欄の中身は下線つきのはず").toBe(true);
    expect(attrCell.underline).toBe(false);
  });

  it("反転・点滅・強調も引き継がない", () => {
    expect(attrCell.reverse).toBe(false);
    expect(attrCell.blink).toBe(false);
    expect(attrCell.intensified).toBe(false);
  });

  it("**色は残す**（5250 側と同じ扱い。桁の存在が見えなくならないように）", () => {
    expect(first.color).toBe("green");
    expect(attrCell.color).toBe("green");
  });
});
