import { describe, it, expect } from "vitest";
import { parseMarkerFormat } from "../src/hostserver/db/marker-format.js";

/**
 * マーカー形式の解析。
 *
 * **テストデータは実機（PUB400）の応答そのもの**である。
 * スパイクで `INSERT INTO MYLIB.ZZPM (C, N) VALUES (?, ?)` を prepare したときに
 * サーバーが返した `0x3813` の中身を、そのまま回帰資産として固定してある。
 * 手で組んだ想定値ではないので、「読み方が実機と合っているか」を守れる。
 */

/** 16 進文字列 → バイト列 */
const bytes = (hex: string): Uint8Array =>
  Uint8Array.from(hex.trim().split(/\s+/).map((h) => parseInt(h, 16)));

/**
 * 実機（PUB400）が返した 138 バイトそのまま。
 * `CREATE TABLE MYLIB.ZZFMT (C CHAR(10), N INTEGER)` に対する
 * `INSERT INTO ... (C, N) VALUES (?, ?)` の prepare 応答。
 */
const REAL_FORMAT = bytes(`
  00 00 00 00 00 00 00 02 00 00 00 00 00 00 00 0e
  00 30 01 c5 00 00 00 0a 00 0a 00 00 01 11 f0 00
  00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00
  00 00 00 60 00 00 00 0d 00 00 00 00 00 00 00 00
  00 30 01 f1 00 00 00 04 00 00 00 09 00 00 f0 00
  00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00
  00 00 00 3d 00 00 00 0d 00 00 00 00 00 00 00 00
  00 00 00 0d 38 40 00 00 f0 f0 f0 f0 f1 00 00 00
  0d 38 40 00 00 f0 f0 f0 f0 f2
`);

describe("parseMarkerFormat（実機の応答で固定）", () => {
  it("列数と行サイズをサーバーの申告どおりに読む", () => {
    const f = parseMarkerFormat(REAL_FORMAT);
    expect(f.fields).toHaveLength(2);
    // CHAR(10) + INTEGER(4) = 14
    expect(f.rowSize).toBe(14);
  });

  it("CHAR 列の型・長さ・CCSID を読む", () => {
    const [c] = parseMarkerFormat(REAL_FORMAT).fields;
    expect(c!.sqlType).toBe(0x01c5); // 453 = CHAR
    expect(c!.length).toBe(10);
    expect(c!.ccsid).toBe(273);
    expect(c!.offset).toBe(0);
  });

  it("INTEGER 列の型・長さ・精度を読む", () => {
    const [, n] = parseMarkerFormat(REAL_FORMAT).fields;
    expect(n!.sqlType).toBe(0x01f1); // 497 = INTEGER
    expect(n!.length).toBe(4);
    expect(n!.precision).toBe(9);
    expect(n!.ccsid).toBe(0); // 数値列に CCSID は無い
  });

  it("**オフセットは長さの累積**（行バッファ内の位置）", () => {
    const f = parseMarkerFormat(REAL_FORMAT);
    expect(f.fields.map((x) => x.offset)).toEqual([0, 10]);
  });
});

describe("壊れた形式は黙って進めない", () => {
  it("ヘッダーより短ければ拒否する", () => {
    expect(() => parseMarkerFormat(new Uint8Array(8))).toThrow(/too short/);
  });

  it("フィールドが途中で切れていれば拒否する", () => {
    expect(() => parseMarkerFormat(REAL_FORMAT.subarray(0, 40))).toThrow(/truncated/);
  });

  it("**長さの累積がサーバーの申告と合わなければ拒否する**（読み方が違う証拠）", () => {
    const broken = Uint8Array.from(REAL_FORMAT);
    new DataView(broken.buffer).setUint32(12, 99); // 行サイズだけ書き換える
    expect(() => parseMarkerFormat(broken)).toThrow(/row size mismatch/);
  });
});
