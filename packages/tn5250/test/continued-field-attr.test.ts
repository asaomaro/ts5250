import { describe, it, expect } from "vitest";
import { ScreenBuffer } from "../src/screen/buffer.js";
import { FFW } from "../src/protocol/constants.js";

/**
 * **継続入力フィールド（EDTMSK 分割）の区切り文字は前の区間の色・下線を引き継ぐ。**
 *
 * ホストは EDTMSK で割った欄を区間ごとの SF で送る。区間の「終端」は**区間の間の
 * 保護された区切り文字（`/`）の桁**で、そこはまだ同じ続きの欄——次の区間の SF が自分の
 * 属性バイトを置くまで、色は前の区間から引き継がれるのが正しい（ACS と実機がそう見せる）。
 *
 * 属性の打ち切り（`fieldEnds`）に区間の終端を含めていたため、**区切り文字だけ既定色（緑）に
 * 戻り、下線も切れて**いた（実機 `ASAOLIB/DTMPGM` の `D8U`＝`COLOR(WHT)`＋`DSPATR(UL)` で
 * 実測: 区切りの色が `rgb(26,127,55)`＝緑、下線なし。利用者のスクリーンショット報告と同じ形）。
 */

const WHITE_UL = 0x26; // 白 ＋ 下線

/** `9999/99/99` の形（4 桁 ＋ `/` ＋ 2 桁 ＋ `/` ＋ 2 桁）を桁どおりに組む */
function maskedDateScreen(): ScreenBuffer {
  const b = new ScreenBuffer();
  const at = (col: number): number => b.addrOf(3, col);
  b.setAttr(at(23), WHITE_UL);
  b.addField(at(24), 4, FFW.ID_VALUE, WHITE_UL, undefined, "first");
  b.setChar(at(28), "/"); // 区切り（保護された桁）
  b.addField(at(29), 2, FFW.ID_VALUE, WHITE_UL, undefined, "middle");
  b.setChar(at(31), "/");
  b.addField(at(32), 2, FFW.ID_VALUE, WHITE_UL, undefined, "last");
  return b;
}
const cellAt = (b: ScreenBuffer, col: number) => b.snapshot("s", false).cells[2]![col - 1]!;

describe("継続入力フィールドの区切り文字の属性", () => {
  it("**区切りの `/` が前の区間の色と下線を保つ**（既定色に戻らない）", () => {
    const b = maskedDateScreen();
    for (const col of [28, 31]) {
      const c = cellAt(b, col);
      expect(c.char).toBe("/");
      expect(c.color, `桁 ${col} の色`).toBe("white");
      expect(c.underline, `桁 ${col} の下線`).toBe(true);
    }
  });

  it("区間の中身も同じ属性のまま", () => {
    const b = maskedDateScreen();
    for (const col of [24, 27, 29, 32, 33]) {
      expect(cellAt(b, col).color, `桁 ${col}`).toBe("white");
      expect(cellAt(b, col).underline, `桁 ${col}`).toBe(true);
    }
  });

  it("**最終区間の終端では既定へ戻す**（属性が欄の外へ漏れない）", () => {
    const b = maskedDateScreen();
    const after = cellAt(b, 34); // last の終端（32+2）
    expect(after.color).toBe("green");
    expect(after.underline).toBe(false);
  });

  it("単独欄（`continued` 無し）は従来どおり終端で既定へ戻す", () => {
    const b = new ScreenBuffer();
    b.setAttr(b.addrOf(5, 9), WHITE_UL);
    b.addField(b.addrOf(5, 10), 4, FFW.ID_VALUE, WHITE_UL);
    const cells = b.snapshot("s", false).cells[4]!;
    expect(cells[12]!.underline).toBe(true); // 桁 13（欄の中）
    expect(cells[13]!.underline).toBe(false); // 桁 14（終端）
    expect(cells[13]!.color).toBe("green");
  });
});
