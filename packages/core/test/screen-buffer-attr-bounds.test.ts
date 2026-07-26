import { describe, it, expect } from "vitest";
import { ScreenBuffer } from "../src/screen/buffer.js";
import { FFW } from "../src/protocol/constants.js";

/**
 * **表示属性の打ち切り位置は、フォーマットテーブルとは別に持つ。**
 *
 * 5250 の下線・色は属性桁から次の属性桁まで効くが、閉じ属性を送らないアプリが多いため、
 * この実装はフィールド長で打ち切っている（`docs/PROTOCOL.md` 4.3。ACS 準拠）。
 * その境界の出所がフォーマットテーブル**だけ**だと、ホストが SOH でテーブルを消したときに
 * **画面の中身は変わっていないのに下線が伸びる**。
 *
 * 実機: WRKOBJPDM で Attn を押すと窓の WTD が SOH を送り、フィールドが 44 → 2 になる。
 * その瞬間に背面「ライブラリー」「位置指定」の下線が右へ伸び、次行へ回り込んでいた。
 */

const UNDERLINE_GREEN = 0x24; // 緑・下線
const ROW = 5;
const ATTR_COL = 10; // 属性桁
const FIELD_COL = 11; // 欄の先頭
const LEN = 6; // → 11..16 が欄、17 が終端

function bufferWithUnderlinedField(): ScreenBuffer {
  const b = new ScreenBuffer();
  b.setAttr(b.addrOf(ROW, ATTR_COL), UNDERLINE_GREEN);
  b.addField(b.addrOf(ROW, FIELD_COL), LEN, FFW.ID_VALUE, UNDERLINE_GREEN);
  return b;
}

/** 指定行で下線が付いている桁の一覧（1 始まり） */
function underlinedCols(b: ScreenBuffer): number[] {
  const snap = b.snapshot("t", false);
  const row = snap.cells[ROW - 1] ?? [];
  return row.map((c, i) => (c.underline ? i + 1 : 0)).filter(Boolean);
}

describe("表示属性の打ち切り位置", () => {
  it("前提: フィールドがあれば下線は欄の終端で止まる", () => {
    const b = bufferWithUnderlinedField();
    expect(underlinedCols(b)).toEqual([11, 12, 13, 14, 15, 16]);
  });

  it("**SOH でフォーマットテーブルが消えても下線は伸びない**", () => {
    const b = bufferWithUnderlinedField();
    b.clearFormatTable(); // ← Attn の窓の WTD がこれを送る
    expect(b.snapshot("t", false).fields).toHaveLength(0); // 入力の受け皿は消える
    expect(underlinedCols(b)).toEqual([11, 12, 13, 14, 15, 16]); // 見え方は変わらない
  });

  it("フォーマットテーブルを消したあと別の場所に欄が定義されても、元の境界は残る", () => {
    const b = bufferWithUnderlinedField();
    b.clearFormatTable();
    // 窓の欄（別の行）。背面とは重ならない
    b.setAttr(b.addrOf(20, 5), 0x20);
    b.addField(b.addrOf(20, 6), 10, FFW.ID_VALUE, 0x20);
    expect(underlinedCols(b)).toEqual([11, 12, 13, 14, 15, 16]);
  });

  it("CLEAR UNIT では境界も消える（次の画面へ古い情報を持ち越さない）", () => {
    const b = bufferWithUnderlinedField();
    b.clearUnit();
    b.setAttr(b.addrOf(ROW, ATTR_COL), UNDERLINE_GREEN); // 欄を定義せず属性だけ置く
    // 境界が残っていれば 17 桁目で切れる。消えていれば行末まで伸びる（＝古い境界が効いていない）
    const cols = underlinedCols(b);
    expect(cols.at(-1)).toBeGreaterThan(17);
  });

  it("SAVE / RESTORE SCREEN で境界も退避・復元される", () => {
    const b = bufferWithUnderlinedField();
    b.saveScreen();
    b.clearUnit(); // 画面ごと差し替え（境界も消える）
    b.restoreScreen();
    expect(underlinedCols(b)).toEqual([11, 12, 13, 14, 15, 16]);
  });

  it("同じ開始アドレスの再定義で境界が新しい長さに追従する", () => {
    const b = bufferWithUnderlinedField();
    b.addField(b.addrOf(ROW, FIELD_COL), 3, FFW.ID_VALUE, UNDERLINE_GREEN); // 6 → 3 桁へ
    expect(underlinedCols(b)).toEqual([11, 12, 13]);
  });

  it("**新しい欄と重なる古い境界は捨てる**（描き直しで古い情報が残らない）", () => {
    const b = bufferWithUnderlinedField();
    b.clearFormatTable();
    // 同じ行を別レイアウトで描き直す: 属性を 10 桁目に置き直し、長い欄を定義する
    b.setAttr(b.addrOf(ROW, ATTR_COL), UNDERLINE_GREEN);
    b.addField(b.addrOf(ROW, FIELD_COL), 12, FFW.ID_VALUE, UNDERLINE_GREEN); // 11..22
    expect(underlinedCols(b)).toEqual([11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22]);
  });
});
