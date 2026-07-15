import { describe, it, expect } from "vitest";
import { applyDataStream } from "../src/protocol/wtd-applier.js";
import { ScreenBuffer } from "../src/screen/buffer.js";
import { codecForCcsid } from "../src/codec/codec.js";
import { ESC, COMMAND, ORDER } from "../src/protocol/constants.js";

const codec = codecForCcsid(37);

function e(text: string): number[] {
  return [...codec.encode(text).bytes];
}

/**
 * PDM 等、フィールドの後に閉じ属性を送らないアプリで下線が非編集エリアへ漏れる問題の回帰。
 * フィールド属性（下線）はフィールド長で境界付けられ、フィールドを越えて漏れないこと。
 */
describe("フィールド属性の境界付け（ACS 準拠）", () => {
  it("下線フィールドの下線はフィールド長で止まり、後続セルへ漏れない", () => {
    const buf = new ScreenBuffer();
    // SBA(1,5) → SF(FFW=0x4000, attr=0x24 緑下線, len=3) → 後続に閉じ属性なしでテキスト
    const data = Uint8Array.from([
      ESC, COMMAND.WRITE_TO_DISPLAY, 0x00, 0x00,
      ORDER.SBA, 1, 5,
      ORDER.SF, 0x40, 0x00, 0x24, 0x00, 0x03,
      ...e("ABC"), // フィールド内容（3 桁）
      ...e("XYZ") // フィールド外（閉じ属性なし）
    ]);
    applyDataStream(data, buf, codec, () => {});
    const snap = buf.snapshot("t", false);
    const row = snap.cells[0]!;

    // 属性桁(1,5)は下線なしのブランク。フィールド (1,6)-(1,8) は下線
    expect(row[5]!.underline).toBe(true); // 'A' (col 6)
    expect(row[6]!.underline).toBe(true); // 'B'
    expect(row[7]!.underline).toBe(true); // 'C'
    // フィールド終端 (1,9) 以降は下線が漏れない（ACS 準拠の境界付け）
    expect(row[8]!.underline).toBe(false); // 'X' (col 9)
    expect(row[9]!.underline).toBe(false); // 'Y'
    expect(row[20]!.underline).toBe(false); // 遠い空白セルも漏れなし
  });

  it("明示的な閉じ属性がある場合はそれに従う", () => {
    const buf = new ScreenBuffer();
    const data = Uint8Array.from([
      ESC, COMMAND.WRITE_TO_DISPLAY, 0x00, 0x00,
      ORDER.SBA, 1, 5,
      ORDER.SF, 0x40, 0x00, 0x24, 0x00, 0x03,
      ...e("ABC"),
      0x20, // 明示的な normal 属性（閉じ）
      ...e("XY")
    ]);
    applyDataStream(data, buf, codec, () => {});
    const row = buf.snapshot("t", false).cells[0]!;
    expect(row[7]!.underline).toBe(true); // 'C' フィールド内
    expect(row[9]!.underline).toBe(false); // 明示 normal 後
  });
});
