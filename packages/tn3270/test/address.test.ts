import { describe, it, expect } from "vitest";
import {
  decodeAddress,
  encodeAddress,
  toRowCol,
  fromRowCol,
  MAX_12BIT, encodeAttribute } from "../src/protocol/address.js";

describe("バッファアドレス 12 ビット形式", () => {
  it("実測値と一致する（negotiation-hercules.trc）", () => {
    // `11 40 40` → 0（画面先頭）
    expect(decodeAddress(0x40, 0x40)).toBe(0);
    // `11 c1 50` → 80（2 行目 1 桁）。表の index 1 と 16 → 1*64+16
    expect(decodeAddress(0xc1, 0x50)).toBe(80);
  });

  it("符号化と復号が往復する", () => {
    for (const addr of [0, 1, 63, 64, 79, 80, 1919, 2000, 3563, MAX_12BIT - 1]) {
      const [hi, lo] = encodeAddress(addr);
      expect(decodeAddress(hi, lo), `addr=${addr}`).toBe(addr);
    }
  });

  it("12 ビットの範囲外は弾く", () => {
    expect(() => encodeAddress(MAX_12BIT)).toThrow(/out of 12-bit range/);
    expect(() => encodeAddress(-1)).toThrow(/out of 12-bit range/);
  });

  it("表に無いバイトは PROTOCOL_ERROR", () => {
    // 0xff は CODE 表に無い。**黙って 0 にしない**——壊れた入力を握り潰すと後段で気づけない
    expect(() => decodeAddress(0xff, 0x40)).toThrow(/invalid 12-bit buffer address/);
  });
});

describe("バッファアドレス 14 ビット形式", () => {
  it("先頭バイトの上位 2 ビットが 00 なら 14 ビットとして読む", () => {
    // 0x00 0x00 → 0
    expect(decodeAddress(0x00, 0x00)).toBe(0);
    // 0x01 0x10 → (1<<6)|16 = 80
    expect(decodeAddress(0x01, 0x10)).toBe(80);
    // 下位 6 ビットだけを使う（上位ビットは無視される）
    expect(decodeAddress(0x01, 0x50)).toBe((1 << 6) | 0x10);
  });
});

describe("バッファアドレス 16 ビット形式", () => {
  it("4,096 桁を超える画面では 2 バイトをそのまま連結する", () => {
    const big = 5000;
    expect(decodeAddress(0x12, 0x34, big)).toBe(0x1234);
    expect(encodeAddress(0x1234, big)).toEqual([0x12, 0x34]);
  });
});

describe("行桁の相互変換", () => {
  it("1 始まりで往復する", () => {
    expect(toRowCol(0, 80)).toEqual({ row: 1, col: 1 });
    expect(toRowCol(79, 80)).toEqual({ row: 1, col: 80 });
    expect(toRowCol(80, 80)).toEqual({ row: 2, col: 1 });
    expect(fromRowCol(2, 1, 80)).toBe(80);
    expect(fromRowCol(24, 80, 80)).toBe(1919);
  });

  it("27x132（モデル 5）でも合う", () => {
    expect(fromRowCol(27, 132, 132)).toBe(27 * 132 - 1);
    expect(toRowCol(27 * 132 - 1, 132)).toEqual({ row: 27, col: 132 });
  });
});

describe("欄属性バイトの送信形式（encodeAttribute）", () => {
  /**
   * 0x00〜0xff の 256 通りを SF で書き込み、s3270 に Read Buffer を撃って応答を採った
   * （`artifacts/s3270-readbuffer-attr-256.hex`）。**全 256 通りが `CODE[attr & 0x3d]`** だった。
   * ここでは代表値と不変条件を押さえる。
   */
  it("**意味の無いビットは落ちる**（0x02 / 0x40 / 0x80）", () => {
    expect(encodeAttribute(0x00)).toBe(0x40); // 実測
    expect(encodeAttribute(0x02)).toBe(0x40); // 0x02 は無視される
    expect(encodeAttribute(0x40)).toBe(0x40);
    expect(encodeAttribute(0x80)).toBe(0x40);
    expect(encodeAttribute(0xc2)).toBe(0x40); // 3 ビットまとめて落ちる
  });

  it("**意味のあるビットは残る**（実測値と一致）", () => {
    expect(encodeAttribute(0x60)).toBe(0x60); // 保護。s3270 もそのまま返した
    expect(encodeAttribute(0xf2)).toBe(0xf0); // 実測
    expect(encodeAttribute(0xff)).toBe(0x7d); // 実測。全ビット立て → 0x3d を引き直す
    expect(encodeAttribute(0xcc)).toBe(0x4c); // 実測
    expect(encodeAttribute(0xe0)).toBe(0x60); // 実測
  });

  it("**アドレスと同じ表**を使う——6 ビット値として引き直すだけ", () => {
    for (let a = 0; a < 256; a++) {
      const [, lo] = encodeAddress(a & 0x3d);
      expect(encodeAttribute(a)).toBe(lo);
    }
  });
});
