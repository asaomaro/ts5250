import { describe, it, expect } from "vitest";
import {
  buildMarkerData,
  encodeMarkerRow,
  markerDataSize,
  MarkerEncodeError
} from "../src/hostserver/db/marker-encode.js";
import type { MarkerFormat } from "../src/hostserver/db/marker-format.js";
import { DB2 } from "../src/hostserver/db/db-types.js";
import { codecForCcsid } from "../src/codec/codec.js";

/**
 * マーカー値の符号化。**本作業のロジックの中心**なので厚く書く。
 *
 * ここが守るのは「サーバーが教えた枠に、値を正しく置く」ことだけ。
 * 枠の大きさ（型ごとのバイト数）は形式が持っており、こちらは計算しない。
 */

/** 形式を組み立てる小道具。offset は length の累積 */
function fmt(...fields: { sqlType: number; length: number; scale?: number; precision?: number; ccsid?: number }[]): MarkerFormat {
  let offset = 0;
  const out = fields.map((f) => {
    const field = {
      sqlType: f.sqlType,
      length: f.length,
      scale: f.scale ?? 0,
      precision: f.precision ?? 0,
      ccsid: f.ccsid ?? 0,
      offset
    };
    offset += f.length;
    return field;
  });
  return { fields: out, rowSize: offset };
}

const hex = (b: Uint8Array) => [...b].map((x) => x.toString(16).padStart(2, "0")).join(" ");

describe("整数", () => {
  it("枠の幅でビッグエンディアンに置く", () => {
    const f = fmt(
      { sqlType: DB2.SMALLINT, length: 2 },
      { sqlType: DB2.INTEGER, length: 4 },
      { sqlType: DB2.BIGINT, length: 8 }
    );
    const { data } = encodeMarkerRow(f, ["258", "66051", "1"]);
    expect(hex(data.subarray(0, 2))).toBe("01 02");
    expect(hex(data.subarray(2, 6))).toBe("00 01 02 03");
    expect(hex(data.subarray(6, 14))).toBe("00 00 00 00 00 00 00 01");
  });

  it("負数を 2 の補数で置く", () => {
    const { data } = encodeMarkerRow(fmt({ sqlType: DB2.INTEGER, length: 4 }), ["-1"]);
    expect(hex(data)).toBe("ff ff ff ff");
  });

  it("**枠に収まらない値は拒否する**（切り詰めない）", () => {
    const f = fmt({ sqlType: DB2.SMALLINT, length: 2 });
    expect(() => encodeMarkerRow(f, ["32768"])).toThrow(/収まりません/);
    expect(() => encodeMarkerRow(f, ["-32769"])).toThrow(/収まりません/);
    expect(() => encodeMarkerRow(f, ["32767"])).not.toThrow();
  });

  it("数値でない値は列を添えて拒否する", () => {
    const f = fmt({ sqlType: DB2.INTEGER, length: 4 });
    try {
      encodeMarkerRow(f, ["未定"]);
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(MarkerEncodeError);
      expect((e as MarkerEncodeError).columnIndex).toBe(0);
      expect((e as MarkerEncodeError).message).toMatch(/数値として解釈できません/);
    }
  });
});

describe("固定長の文字（CHAR）", () => {
  const f = (ccsid: number) => fmt({ sqlType: DB2.CHAR, length: 10, ccsid });

  it("列の CCSID で符号化し、右を EBCDIC 空白で詰める", () => {
    const { data } = encodeMarkerRow(f(37), ["AB"]);
    expect(data.length).toBe(10);
    expect(hex(data.subarray(0, 2))).toBe("c1 c2"); // 'A','B'
    expect([...data.subarray(2)].every((b) => b === 0x40)).toBe(true);
  });

  it("**同じ文字でも列の CCSID で違うバイトになる**", () => {
    const at37 = encodeMarkerRow(f(37), ["@"]).data[0];
    const at273 = encodeMarkerRow(f(273), ["@"]).data[0];
    expect(at37).not.toBe(at273);
  });

  it("**日本語は混在 CCSID の列に書ける**（SO/SI 込み）", () => {
    const { data } = encodeMarkerRow(fmt({ sqlType: DB2.CHAR, length: 20, ccsid: 5035 }), ["日本語"]);
    expect(data[0]).toBe(0x0e); // SO
    // 実機で確認した並びと一致すること（前作業の基準行と同じ）
    expect(hex(data.subarray(0, 8))).toBe("0e 45 62 45 66 48 e7 0f");
  });

  it("**書けない文字は置換せず、どの文字かを添えて拒否する**", () => {
    // CCSID 273（ドイツ語圏 SBCS）に日本語は無い
    try {
      encodeMarkerRow(fmt({ sqlType: DB2.CHAR, length: 20, ccsid: 273 }), ["日本"]);
      expect.unreachable();
    } catch (e) {
      expect((e as MarkerEncodeError).message).toMatch(/日, 本/);
    }
  });

  it("枠を超える値は切り詰めずに拒否する", () => {
    expect(() => encodeMarkerRow(f(37), ["ABCDEFGHIJK"])).toThrow(/バイトの列に/);
  });
});

describe("可変長の文字（VARCHAR）", () => {
  // 枠は「宣言長 + 2」で与えられる
  const f = fmt({ sqlType: DB2.VARCHAR, length: 32, ccsid: 37 });

  it("**2 バイトの長さ ＋ 本体**を置く", () => {
    const { data } = encodeMarkerRow(f, ["ABC"]);
    expect(new DataView(data.buffer).getUint16(0)).toBe(3);
    expect(hex(data.subarray(2, 5))).toBe("c1 c2 c3");
  });

  it("空文字は長さ 0", () => {
    const { data } = encodeMarkerRow(f, [""]);
    expect(new DataView(data.buffer).getUint16(0)).toBe(0);
  });

  it("**引用符を含む値をそのまま置く**（エスケープが要らない）", () => {
    const { data } = encodeMarkerRow(f, ["quote'test"]);
    const len = new DataView(data.buffer).getUint16(0);
    expect(codecForCcsid(37).decode(data.subarray(2, 2 + len))).toBe("quote'test");
  });

  it("宣言長を超えたら拒否する（枠から 2 を引いた値で判定）", () => {
    expect(() => encodeMarkerRow(f, ["x".repeat(31)])).toThrow(/バイトの列に/);
    expect(() => encodeMarkerRow(f, ["x".repeat(30)])).not.toThrow();
  });
});

describe("10 進系は既存のエンコーダを再利用する", () => {
  it("DECIMAL はパック 10 進", () => {
    const f = fmt({ sqlType: DB2.DECIMAL, length: 4, precision: 7, scale: 2 });
    const { data } = encodeMarkerRow(f, ["12.34"]);
    // precision=7 なので桁は 0001234、末尾ニブルが符号 F
    expect(hex(data)).toBe("00 01 23 4f");
  });

  it("NUMERIC はゾーン 10 進", () => {
    const f = fmt({ sqlType: DB2.NUMERIC, length: 5, precision: 5, scale: 0 });
    const { data } = encodeMarkerRow(f, ["123"]);
    expect(hex(data)).toBe("f0 f0 f1 f2 f3");
  });

  it("位取りに収まらない小数は拒否する（切り捨てない）", () => {
    const f = fmt({ sqlType: DB2.DECIMAL, length: 4, precision: 7, scale: 2 });
    expect(() => encodeMarkerRow(f, ["1.239"])).toThrow();
  });
});

describe("日付時刻は文字列としてそのまま置く", () => {
  it("ホストに解釈させる（こちらで書式を作らない）", () => {
    const f = fmt({ sqlType: DB2.DATE, length: 10, ccsid: 37 });
    const { data } = encodeMarkerRow(f, ["2026-07-20"]);
    expect(codecForCcsid(37).decode(data)).toBe("2026-07-20");
  });
});

describe("NULL", () => {
  it("**指標だけを立て、データ領域は触らない**", () => {
    const f = fmt({ sqlType: DB2.CHAR, length: 4, ccsid: 37 }, { sqlType: DB2.INTEGER, length: 4 });
    const row = encodeMarkerRow(f, [null, "7"]);
    expect(row.nulls).toEqual([true, false]);
    expect(hex(row.data.subarray(0, 4))).toBe("00 00 00 00"); // 初期値のまま
  });
});

describe("対応外の型", () => {
  it("**黙って 0 埋めせず、型名を添えて拒否する**", () => {
    const f = fmt({ sqlType: DB2.BLOB_LOCATOR, length: 4 });
    try {
      encodeMarkerRow(f, ["x"]);
      expect.unreachable();
    } catch (e) {
      expect((e as MarkerEncodeError).code).toBe("UNSUPPORTED_TYPE");
      expect((e as MarkerEncodeError).message).toMatch(/BLOB_LOCATOR/);
    }
  });

  it("CCSID 65535（変換なし）の文字列列も拒否する", () => {
    const f = fmt({ sqlType: DB2.CHAR, length: 4, ccsid: 65535 });
    expect(() => encodeMarkerRow(f, ["x"])).toThrow(/文字コードが不明/);
  });
});

describe("buildMarkerData", () => {
  const f = fmt({ sqlType: DB2.CHAR, length: 4, ccsid: 37 }, { sqlType: DB2.INTEGER, length: 4 });

  it("ヘッダーに行数・列数・指標サイズ・行サイズを書く", () => {
    const rows = [encodeMarkerRow(f, ["A", "1"]), encodeMarkerRow(f, ["B", "2"])];
    const d = buildMarkerData(f, rows);
    const v = new DataView(d.buffer);
    expect(v.getUint32(0)).toBe(1); // 一貫性トークン
    expect(v.getUint32(4)).toBe(2); // 行数
    expect(v.getUint16(8)).toBe(2); // 列数
    expect(v.getUint16(10)).toBe(2); // 指標サイズ
    expect(v.getUint32(16)).toBe(8); // 行サイズ
  });

  it("**指標は行ごとに列数ぶん並ぶ**", () => {
    const rows = [encodeMarkerRow(f, ["A", null]), encodeMarkerRow(f, [null, "2"])];
    const d = buildMarkerData(f, rows);
    const v = new DataView(d.buffer);
    expect(v.getUint16(20)).toBe(0); // 行1列1: 非 NULL
    expect(v.getUint16(22)).toBe(0xffff); // 行1列2: NULL
    expect(v.getUint16(24)).toBe(0xffff); // 行2列1: NULL
    expect(v.getUint16(26)).toBe(0); // 行2列2: 非 NULL
  });

  it("行データは指標の後ろに行サイズ刻みで並ぶ", () => {
    const rows = [encodeMarkerRow(f, ["A", "1"]), encodeMarkerRow(f, ["B", "2"])];
    const d = buildMarkerData(f, rows);
    const dataAt = 20 + 2 * 2 * 2;
    expect(d[dataAt]).toBe(0xc1); // 'A'
    expect(d[dataAt + 8]).toBe(0xc2); // 'B'（次の行）
  });

  it("総バイト数が markerDataSize と一致する", () => {
    const rows = [encodeMarkerRow(f, ["A", "1"])];
    expect(buildMarkerData(f, rows).length).toBe(markerDataSize(f, 1));
    expect(markerDataSize(f, 100)).toBe(20 + 100 * 2 * 2 + 100 * 8);
  });

  it("1 行でも 100 行でも構造は同じ（行数が変わるだけ）", () => {
    const many = Array.from({ length: 100 }, (_, i) => encodeMarkerRow(f, ["X", String(i)]));
    const d = buildMarkerData(f, many);
    expect(new DataView(d.buffer).getUint32(4)).toBe(100);
    expect(d.length).toBe(markerDataSize(f, 100));
  });
});

describe("値の数", () => {
  it("列数と合わなければ拒否する", () => {
    const f = fmt({ sqlType: DB2.INTEGER, length: 4 });
    expect(() => encodeMarkerRow(f, ["1", "2"])).toThrow(/値の数が一致しません/);
  });
});
