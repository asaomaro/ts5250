import { describe, it, expect } from "vitest";
import {
  encodeChar,
  encodeInt,
  encodePacked,
  encodeZoned,
  toDigits
} from "../src/hostserver/ddm/encode.js";
import { buildRecordLayout } from "../src/hostserver/ddm/record-layout.js";
import { codecForCcsid } from "../src/codec/codec.js";

const enc = (t: string) => codecForCcsid(37).encode(t);
const hex = (b: Uint8Array) => [...b].map((x) => x.toString(16).padStart(2, "0")).join(" ");

/**
 * DDM 書き込みのバイト変換。
 *
 * **実機に出る前に固められる唯一の部分**なので厚めに書く
 * （SQL 実装の retro が「真の難所は型変換」と記録している）。
 */
describe("toDigits", () => {
  it("位取りに合わせて小数部を詰める", () => {
    expect(toDigits("12.5", 5, 2)).toEqual({ negative: false, digits: "01250" });
  });

  it("整数を位取りぶん左シフトする", () => {
    expect(toDigits(7, 5, 2)).toEqual({ negative: false, digits: "00700" });
  });

  it("負号を分離する", () => {
    expect(toDigits("-3.4", 3, 1)).toEqual({ negative: true, digits: "034" });
  });

  it("**切り捨てずに拒否する**（黙って値を変えない）", () => {
    expect(() => toDigits("1.239", 5, 2)).toThrow(/位取り/);
  });

  it("末尾がゼロなら位取りに収まる扱いにする", () => {
    expect(toDigits("1.2300", 5, 2)).toEqual({ negative: false, digits: "00123" });
  });

  it("桁あふれを拒否する", () => {
    expect(() => toDigits("123456", 5, 0)).toThrow(/桁数/);
  });

  it("数値として読めないものを拒否する", () => {
    expect(() => toDigits("abc", 5, 0)).toThrow(/解釈できません/);
  });
});

describe("encodePacked（パック 10 進）", () => {
  it("正数: 最終ニブルが 0xF", () => {
    // DECIMAL(5,0) の 123 → 3 バイト: 00 12 3F
    expect(hex(encodePacked(123, 5, 0))).toBe("00 12 3f");
  });

  it("負数: 最終ニブルが 0xD", () => {
    expect(hex(encodePacked(-123, 5, 0))).toBe("00 12 3d");
  });

  it("位取りを反映する", () => {
    // DECIMAL(5,2) の 12.34 → 01234 → 01 23 4F
    expect(hex(encodePacked("12.34", 5, 2))).toBe("01 23 4f");
  });

  it("バイト数は floor(precision/2)+1", () => {
    expect(encodePacked(0, 5, 0)).toHaveLength(3);
    expect(encodePacked(0, 6, 0)).toHaveLength(4);
    expect(encodePacked(0, 9, 0)).toHaveLength(5);
  });

  it("ゼロを表現できる", () => {
    expect(hex(encodePacked(0, 5, 0))).toBe("00 00 0f");
  });
});

describe("encodeZoned（ゾーン 10 進）", () => {
  it("1 バイト 1 桁の EBCDIC 数字", () => {
    // NUMERIC(5,0) の 123 → F0 F0 F1 F2 F3
    expect(hex(encodeZoned(123, 5, 0))).toBe("f0 f0 f1 f2 f3");
  });

  it("負数は最終バイトの上位ニブルが 0xD", () => {
    expect(hex(encodeZoned(-123, 5, 0))).toBe("f0 f0 f1 f2 d3");
  });

  it("バイト数は precision と一致", () => {
    expect(encodeZoned(1, 7, 0)).toHaveLength(7);
  });
});

describe("encodeInt", () => {
  it("ビッグエンディアンで書く", () => {
    expect(hex(encodeInt(1, 2))).toBe("00 01");
    expect(hex(encodeInt(258, 2))).toBe("01 02");
    expect(hex(encodeInt(1, 4))).toBe("00 00 00 01");
  });

  it("負数を 2 の補数で書く", () => {
    expect(hex(encodeInt(-1, 2))).toBe("ff ff");
    expect(hex(encodeInt(-2, 4))).toBe("ff ff ff fe");
  });

  it("bigint を受ける（double で表せない桁）", () => {
    expect(hex(encodeInt(9007199254740993n, 8))).toBe("00 20 00 00 00 00 00 01");
  });

  it("範囲外を拒否する", () => {
    expect(() => encodeInt(32768, 2)).toThrow(/収まりません/);
    expect(() => encodeInt(-32769, 2)).toThrow(/収まりません/);
  });
});

describe("encodeChar", () => {
  it("右を EBCDIC の空白（0x40）で詰める", () => {
    expect(hex(encodeChar("AB", 4, enc))).toBe("c1 c2 40 40");
  });

  it("ちょうどの長さは詰めない", () => {
    expect(hex(encodeChar("AB", 2, enc))).toBe("c1 c2");
  });

  it("**切らずに拒否する**（欠けたことに気づけないため）", () => {
    expect(() => encodeChar("ABCDE", 3, enc)).toThrow(/超えます/);
  });

  it("空文字は全部空白", () => {
    expect(hex(encodeChar("", 3, enc))).toBe("40 40 40");
  });
});

describe("buildRecordLayout", () => {
  const col = (name: string, dataType: string, length: number, scale = 0) => ({
    name,
    dataType,
    length,
    scale,
    nullable: false
  });

  it("宣言順に連続配置し、合計長を出す", () => {
    const l = buildRecordLayout([col("A", "CHAR", 10), col("B", "DECIMAL", 5, 2)]);
    expect(l.fields.map((f) => [f.name, f.offset, f.size])).toEqual([
      ["A", 0, 10],
      ["B", 10, 3]
    ]);
    expect(l.recordLength).toBe(13);
  });

  it("型ごとのバイト数", () => {
    const l = buildRecordLayout([
      col("C", "CHAR", 4),
      col("D", "DECIMAL", 7, 0),
      col("N", "NUMERIC", 6, 0),
      col("S", "SMALLINT", 5),
      col("I", "INTEGER", 10),
      col("B", "BIGINT", 19)
    ]);
    expect(l.fields.map((f) => f.size)).toEqual([4, 4, 6, 2, 4, 8]);
    expect(l.fields.map((f) => f.kind)).toEqual([
      "char",
      "packed",
      "zoned",
      "int",
      "int",
      "int"
    ]);
  });

  it("**対応外の型はレコード全体を拒否する**（部分的に書けても意味が無い）", () => {
    expect(() => buildRecordLayout([col("A", "CHAR", 4), col("V", "VARCHAR", 10)])).toThrow(
      /対応していない型/
    );
    expect(() => buildRecordLayout([col("D", "DATE", 10)])).toThrow(/DATE/);
  });

  it("型名の大小・空白を吸収する", () => {
    expect(buildRecordLayout([col("A", " char ", 3)]).fields[0]!.kind).toBe("char");
  });

  it("列が無ければ拒否する", () => {
    expect(() => buildRecordLayout([])).toThrow(/列がありません/);
  });
});

describe("encodeChar: 変換できない文字", () => {
  it("**置換文字を黙って書かない**（実機で  が 3 つ書かれた）", () => {
    // CCSID 37（SBCS）に日本語を渡すと置換される
    expect(() => encodeChar("ベータ", 10, enc)).toThrow(/表せない文字/);
  });

  it("DBCS 対応のコードページなら通る", () => {
    const enc939 = (t: string) => codecForCcsid(939).encode(t);
    expect(() => encodeChar("ベータ", 20, enc939)).not.toThrow();
  });
});

/**
 * 列ごとの CCSID（design D1）。
 *
 * 従来はレコードのデータ部を CCSID 37 で固定していたが、実機の表は 273 が主で
 * 日本語列は 5035/930 と**同じ表の中で混在する**（research F3/F4）。
 * ここは実機なしで固められる部分なので、符号化が列ごとに切り替わることを固定する。
 */
describe("列ごとの CCSID", () => {
  const cols = [
    { name: "C_SBCS", dataType: "CHAR", length: 4, scale: 0, nullable: true, ccsid: 273 },
    { name: "C_JP", dataType: "CHAR", length: 10, scale: 0, nullable: true, ccsid: 5035 },
    { name: "N", dataType: "INTEGER", length: 10, scale: 0, nullable: true }
  ];

  it("文字列列にだけ ccsid を運ぶ（数値列には付けない）", () => {
    const layout = buildRecordLayout(cols);
    expect(layout.fields[0]!.ccsid).toBe(273);
    expect(layout.fields[1]!.ccsid).toBe(5035);
    expect(layout.fields[2]!.ccsid).toBeUndefined();
  });

  it("CHAR の size は宣言どおりのバイト数（混在 CCSID でも変わらない）", () => {
    // research F8: 実機で LENGTH = CHARACTER_OCTET_LENGTH を確認済み
    const layout = buildRecordLayout(cols);
    expect(layout.fields[0]!.size).toBe(4);
    expect(layout.fields[1]!.size).toBe(10);
    expect(layout.recordLength).toBe(4 + 10 + 4);
  });

  it("**同じ文字列でも列の CCSID で違うバイトになる**", () => {
    // '@' は CCSID 37 では 0x7C、273 では 0xB5（variant 文字）
    const at37 = codecForCcsid(37).encode("@").bytes;
    const at273 = codecForCcsid(273).encode("@").bytes;
    expect(hex(at37)).not.toBe(hex(at273));
  });

  it("混在 CCSID の列は SO/SI 込みでバイト長を数える", () => {
    // 5035 は SBCS/DBCS 混在。日本語 1 文字 = SO + 2 バイト + SI = 4 バイト
    const { bytes } = codecForCcsid(5035).encode("日");
    expect(bytes.length).toBe(4);
    expect(bytes[0]).toBe(0x0e); // SO
    expect(bytes[bytes.length - 1]).toBe(0x0f); // SI
  });

  it("列に収まらなければ切り詰めずに拒否する", () => {
    // CHAR(4) に 日本語(SO+2+2+2+SI = 8 バイト) は入らない
    const jp = (t: string) => codecForCcsid(5035).encode(t);
    expect(() => encodeChar("日本", 4, jp)).toThrow();
  });

  it("表現できない文字は置換せずに拒否する", () => {
    // CCSID 273（ドイツ語圏 SBCS）に日本語は無い
    const de = (t: string) => codecForCcsid(273).encode(t);
    expect(() => encodeChar("日", 20, de)).toThrow();
  });
});

describe("buildDdmRecord が列ごとの CCSID を使う", () => {
  it("**同じ表の 273 列と 5035 列を別々に符号化する**", async () => {
    const { buildDdmRecord } = await import("../src/hostserver/ddm/ddm-connection.js");
    const layout = buildRecordLayout([
      { name: "A", dataType: "CHAR", length: 2, scale: 0, nullable: false, ccsid: 273 },
      { name: "B", dataType: "CHAR", length: 8, scale: 0, nullable: false, ccsid: 5035 }
    ]);
    const rec = buildDdmRecord(layout, ["@", "日本"]);

    // A: 273 の '@' は 0xB5（37 の 0x7C ではない）＝列の CCSID が効いている証拠
    expect(rec.data[0]).toBe(0xb5);
    // B: 5035 の日本語は SO … SI で囲まれる
    expect(rec.data[2]).toBe(0x0e);
    expect(rec.data[7]).toBe(0x0f);
  });

  it("CCSID 273 の列に日本語を入れると拒否する（置換しない）", async () => {
    const { buildDdmRecord } = await import("../src/hostserver/ddm/ddm-connection.js");
    const layout = buildRecordLayout([
      { name: "A", dataType: "CHAR", length: 20, scale: 0, nullable: false, ccsid: 273 }
    ]);
    expect(() => buildDdmRecord(layout, ["日本語"])).toThrow();
  });
});
