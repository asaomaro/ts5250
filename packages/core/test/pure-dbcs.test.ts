import { describe, it, expect } from "vitest";
import {
  PureDbcsCodec,
  ibm16684,
  ibm300,
  pureDbcsCodecForCcsid,
  isPureDbcsCcsid
} from "../src/codec/pure-dbcs.js";

/**
 * 純 DBCS は SQL の GRAPHIC / VARGRAPHIC 列が使う。混在 CCSID と違い SO/SI が無く 2 バイト固定。
 *
 * CCSID 300 は 16684 に差分を当てたもの（JTOpen 本体 ConvTable300 と同じ方式）。
 * 差分は波ダッシュ・全角チルダ問題そのものなので、**両者で結果が変わることを固定する**。
 */
const c16684 = new PureDbcsCodec(ibm16684);
const c300 = new PureDbcsCodec(ibm300);
const bytes = (...b: number[]): Uint8Array => Uint8Array.from(b);

describe("PureDbcsCodec（2 バイト固定）", () => {
  it("2 バイトずつ 1 文字に畳む", () => {
    // 日 = 0x4562、本 = 0x4566（実機テスト表に入れた値）
    expect(c16684.decode(bytes(0x45, 0x62, 0x45, 0x66))).toBe("日本");
  });

  it("エンコードは往復する", () => {
    const { bytes: b, substituted } = c16684.encode("日本");
    expect(substituted).toBe(0);
    expect([...b]).toEqual([0x45, 0x62, 0x45, 0x66]);
    expect(c16684.decode(b)).toBe("日本");
  });

  it("カタカナも往復する（実機テスト表の値）", () => {
    // ア = 0x4381、イ = 0x4382
    expect(c300.decode(bytes(0x43, 0x81, 0x43, 0x82))).toBe("アイ");
    expect([...c300.encode("アイ").bytes]).toEqual([0x43, 0x81, 0x43, 0x82]);
  });

  it("SO/SI を解釈しない（純 DBCS には現れないため、2 バイトの文字として扱う）", () => {
    // 0x0E0F を SO/SI として解釈すれば空文字になるが、純 DBCS では 1 文字として引く
    expect(c16684.decode(bytes(0x0e, 0x0f))).not.toBe("");
  });

  it("末尾に 1 バイト余っても例外にせず切り捨てる", () => {
    expect(c16684.decode(bytes(0x45, 0x62, 0x45))).toBe("日");
  });

  it("空バイト列は空文字", () => {
    expect(c16684.decode(bytes())).toBe("");
  });

  it("マップ不能な文字は SUB に置換し substituted に数える", () => {
    const r = c16684.encode("\u{1F600}"); // 絵文字は DBCS に無い
    expect(r.substituted).toBeGreaterThan(0);
    expect([...r.bytes]).toEqual([0xfe, 0xfe]); // DBCS SUB
  });

  it("未定義のバイト対は置換文字になる", () => {
    expect(c16684.decode(bytes(0xff, 0xff))).toBe("�");
  });

  it("decodeByte は純 DBCS に 1 バイト文字が無いため置換文字を返す", () => {
    expect(c16684.decodeByte()).toBe(0xfffd);
  });
});

describe("CCSID 300 と 16684 の差分（波ダッシュ・全角チルダ問題）", () => {
  /**
   * JTOpen 本体 ConvTable300 が 16684 に当てている差分。
   * 16684 は Unicode 規格寄り、300 は既存クライアント（ACS / jt400）互換。
   * このプロジェクトは ACS の代替なので 300 側を原典に合わせる。
   */
  const DIFFS: ReadonlyArray<[number, string, string, string]> = [
    [0x4260, "−", "－", "MINUS SIGN → FULLWIDTH HYPHEN-MINUS"],
    [0x426a, "¦", "￤", "BROKEN BAR → FULLWIDTH BROKEN BAR"],
    [0x43a1, "〜", "～", "WAVE DASH → FULLWIDTH TILDE"],
    [0x444a, "—", "―", "EM DASH → HORIZONTAL BAR"],
    [0x447c, "‖", "∥", "DOUBLE VERTICAL LINE → PARALLEL TO"]
  ];

  it.each(DIFFS)("0x%s: 16684 と 300 で結果が変わる (%s)", (pair, in16684, in300, _label) => {
    const b = bytes((pair as number) >> 8, (pair as number) & 0xff);
    expect(c16684.decode(b)).toBe(in16684);
    expect(c300.decode(b)).toBe(in300);
    expect(in16684).not.toBe(in300);
  });

  it("差分は 5 箇所のみで、他は 16684 と同じ", () => {
    expect(c300.decode(bytes(0x45, 0x62))).toBe(c16684.decode(bytes(0x45, 0x62)));
  });

  it("逆方向も差分が効く（全角チルダ → 0x43A1）", () => {
    expect([...c300.encode("～").bytes]).toEqual([0x43, 0xa1]);
  });

  it("16684 の表そのものを壊していない（差分は複製に対して当てる）", () => {
    // ibm300 を作った副作用で ibm16684 が書き換わっていないこと
    expect(c16684.decode(bytes(0x43, 0xa1))).toBe("〜");
  });
});

describe("pureDbcsCodecForCcsid", () => {
  it("16684 と 300 を返す", () => {
    expect(pureDbcsCodecForCcsid(16684).ccsid).toBe(16684);
    expect(pureDbcsCodecForCcsid(300).ccsid).toBe(300);
  });

  it("未対応の CCSID は例外にする（混在 CCSID を誤って渡した場合を含む）", () => {
    expect(() => pureDbcsCodecForCcsid(1399)).toThrow(/unsupported pure DBCS CCSID/);
    expect(() => pureDbcsCodecForCcsid(1200)).toThrow(/unsupported/);
  });

  it("isPureDbcsCcsid で判定できる", () => {
    expect(isPureDbcsCcsid(300)).toBe(true);
    expect(isPureDbcsCcsid(16684)).toBe(true);
    expect(isPureDbcsCcsid(1399)).toBe(false);
  });
});

describe("ibm16684 は新たな表を持たない（1399 の DBCS 部の再利用）", () => {
  it("エントリ数が 1399 の DBCS 部と一致する", () => {
    expect(ibm16684.part.ebcdicToUnicode.size).toBeGreaterThan(20000);
  });

  it("subchar は 0xFEFE（ICU の ibm-16684 と一致）", () => {
    expect(ibm16684.part.sub).toBe(0xfefe);
  });
});
