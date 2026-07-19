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
