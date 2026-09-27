import { describe, it, expect } from "vitest";
import { ScreenBuffer } from "../src/screen/buffer.js";
import { FFW } from "../src/protocol/constants.js";
import { rawSentinel } from "../src/screen/attr-sentinel.js";

/**
 * **E（either）欄の全角の状態は欄ごとに持ち続ける**（ACS `Field5250.EitherFieldDBCSOn`。`20260927-either-field-mode`）。
 * 立つのはホストが欄の先頭に SO/SI を書いたとき（ACS の表示データの書き込み）と全角で始まる値を書いたとき、下りるのは半角で始まる値を書いたときだけ。
 * 空の値では変えない——ACS は欄を消しても SO/SI を残して全角のままにする（`PS5250.eraseField_Work`）
 */
function eField(): { b: ScreenBuffer; flag: () => boolean | undefined } {
  const b = new ScreenBuffer();
  b.addField(b.addrOf(5, 20), 12, FFW.ID_VALUE, 0x24, "either");
  return { b, flag: () => b.snapshot("s", false).fields[0]!.eitherDbcsOn };
}

describe("E 欄の全角の状態", () => {
  it("既定は付かない（半角の状態）", () => {
    expect(eField().flag()).toBeUndefined();
  });

  it("**ホストが欄の先頭に SO を書くと全角の状態**（中身が空の `SO SI` でも）", () => {
    const { b, flag } = eField();
    b.setShift(b.addrOf(5, 20), "so");
    b.setShift(b.addrOf(5, 21), "si");
    expect(flag()).toBe(true);
  });

  it("欄の途中の SO では変わらない", () => {
    const { b, flag } = eField();
    b.setShift(b.addrOf(5, 23), "so");
    expect(flag()).toBeUndefined();
  });

  it("**全角で始まる値で立ち、半角で始まる値で下りる。空の値では変えない**", () => {
    const { b, flag } = eField();
    const f = b.fieldByIndex(1);
    b.setFieldValue(f, "あい", true);
    expect(flag()).toBe(true);
    b.setFieldValue(f, "", true);
    expect(flag()).toBe(true);
    b.setFieldValue(f, "   ", true);
    expect(flag()).toBe(true);
    b.setFieldValue(f, "X", true);
    expect(flag()).toBeUndefined();
    b.setFieldValue(f, "　あ", true);
    expect(flag()).toBe(true);
  });

  it("未編集の DBCS 欄の値（SO のセンチネルで始まる）を書き戻しても全角のまま", () => {
    const { b, flag } = eField();
    const f = b.fieldByIndex(1);
    b.setFieldValue(f, rawSentinel(0x0e) + rawSentinel(0x44) + rawSentinel(0x86) + rawSentinel(0x0f), true);
    expect(flag()).toBe(true);
  });

  it("E 欄でなければ付かない（O 欄・SBCS 欄）", () => {
    const b = new ScreenBuffer();
    b.addField(b.addrOf(5, 20), 12, FFW.ID_VALUE, 0x24, "open");
    b.setShift(b.addrOf(5, 20), "so");
    b.setFieldValue(b.fieldByIndex(1), "あ", true);
    expect(b.snapshot("s", false).fields[0]!.eitherDbcsOn).toBeUndefined();
  });

  it("**同じ位置の欄を定義し直しても（SF）全角の状態は残る**（ACS `FFT5250.addFieldToFFT` は同じ位置の欄を使い回す）", () => {
    const { b, flag } = eField();
    b.setFieldValue(b.fieldByIndex(1), "あ", true);
    b.addField(b.addrOf(5, 20), 12, FFW.ID_VALUE, 0x24, "either");
    expect(flag()).toBe(true);
  });

  it("**CLEAR UNIT で欄の表ごと捨てたら消える**（新しく定義した欄は半角の状態）", () => {
    const { b, flag } = eField();
    b.setFieldValue(b.fieldByIndex(1), "あ", true);
    b.clearUnit();
    b.addField(b.addrOf(5, 20), 12, FFW.ID_VALUE, 0x24, "either");
    expect(flag()).toBeUndefined();
  });

  it("申告のある DBCS 欄に `dbcsContent` を付けない（`eitherDbcsOn` を足しても else の相手を変えない）", () => {
    const b = new ScreenBuffer();
    b.addField(b.addrOf(5, 20), 12, FFW.ID_VALUE, 0x24, "only");
    b.setShift(b.addrOf(5, 20), "so");
    b.setDbcs(b.addrOf(5, 21), "あ", 0x44, 0x81);
    b.setShift(b.addrOf(5, 23), "si");
    const f = b.snapshot("s", false).fields[0]!;
    expect(f.dbcsType).toBe("only");
    expect(f.dbcsContent).toBeUndefined();
    expect(f.eitherDbcsOn).toBeUndefined();
  });
});
