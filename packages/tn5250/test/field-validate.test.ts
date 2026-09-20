import { describe, it, expect } from "vitest";
import { validateFieldContent } from "../src/screen/field-validate.js";
import { codecForCcsid } from "@ts5250/ebcdic/codec";
import { FFW } from "../src/protocol/constants.js";
import type { InternalField } from "../src/screen/buffer.js";
import type { DbcsFieldType } from "../src/screen/types.js";

const sbcs = codecForCcsid(37);
const dbcs = codecForCcsid(1399);

function field(ffw: number, dbcsType?: DbcsFieldType): InternalField {
  return { startAddr: 0, length: 20, ffw, attrByte: 0x24, mdt: false, ...(dbcsType ? { dbcsType } : {}) };
}

describe("validateFieldContent — 数値型", () => {
  const numField = field(FFW.ID_VALUE | FFW.SHIFT_NUMERIC_ONLY);
  it("数字・符号・小数点は許可", () => {
    expect(() => validateFieldContent("123.45", numField, sbcs)).not.toThrow();
    expect(() => validateFieldContent("-12", numField, sbcs)).not.toThrow();
  });
  it("英字は FIELD_TYPE で拒否", () => {
    expect(() => validateFieldContent("12A", numField, sbcs)).toThrow(
      expect.objectContaining({ code: "FIELD_TYPE" })
    );
  });
  it("digits-only は小数点も拒否", () => {
    const digits = field(FFW.ID_VALUE | FFW.SHIFT_DIGITS_ONLY);
    expect(() => validateFieldContent("12.3", digits, sbcs)).toThrow(
      expect.objectContaining({ code: "FIELD_TYPE" })
    );
  });

  // 右寄せ（FFW の ADJUST・signed-num の既定）は値の左右に空白を作る。これは桁合わせの
  // padding であって入力文字ではないので通す。埋め込みの空白は従来どおり弾く。
  it("前後の空白は padding として許可（右寄せ後の値を自分で送れるように）", () => {
    expect(() => validateFieldContent("    12", numField, sbcs)).not.toThrow();
    expect(() => validateFieldContent("12    ", numField, sbcs)).not.toThrow();
    expect(() => validateFieldContent("    12 ", numField, sbcs)).not.toThrow();
  });
  // **（`.aidev/works/20260915-acs-field-validation-audit` での訂正）**:
  // ACS のデコンパイル済みコア（`Field5250.checkNumericOnlyChar()`）は数値専用欄で
  // 埋め込みの空白も許容しており、それに合わせて許可する形へ変更した
  // （research.md F2）。`SHIFT_DIGITS_ONLY` は対象外（ACS の
  // `checkDigitsOnlyChar()` は空白を許容しない。research.md F3。下の
  // 「digits-only でも前後の空白は許可・埋め込みは拒否」テスト参照）。
  it("埋め込みの空白も許可（ACS の checkNumericOnlyChar() と一致させた）", () => {
    expect(() => validateFieldContent("1 2", numField, sbcs)).not.toThrow();
  });
  it("digits-only でも前後の空白は許可・埋め込みは拒否", () => {
    const digits = field(FFW.ID_VALUE | FFW.SHIFT_DIGITS_ONLY);
    expect(() => validateFieldContent("  123", digits, sbcs)).not.toThrow();
    expect(() => validateFieldContent("1 3", digits, sbcs)).toThrow(
      expect.objectContaining({ code: "FIELD_TYPE" })
    );
  });
});

describe("validateFieldContent — コードページ許容文字", () => {
  it("CCSID 37 の英数字は許可", () => {
    expect(() => validateFieldContent("HELLO123", field(FFW.ID_VALUE), sbcs)).not.toThrow();
  });
  it("CCSID 37 に日本語は入力不可（FIELD_TYPE）", () => {
    expect(() => validateFieldContent("あ", field(FFW.ID_VALUE), sbcs)).toThrow(
      expect.objectContaining({ code: "FIELD_TYPE" })
    );
  });
  it("CCSID 1399 では日本語も英数字も許可", () => {
    expect(() => validateFieldContent("日本ABC", field(FFW.ID_VALUE), dbcs)).not.toThrow();
  });
});

describe("validateFieldContent — DBCS 種別", () => {
  // **only（0x8200）が J 型。** 以前は 0x8200 を "pure" と呼んでいたので、4 値化で
  // J 型の全角専用検査が外れないことをここで固定する
  it("only（J 型・FCW 0x8200）は DBCS のみ許可、SBCS を拒否", () => {
    const only = field(FFW.ID_VALUE, "only");
    expect(() => validateFieldContent("日本語", only, dbcs)).not.toThrow();
    expect(() => validateFieldContent("日A", only, dbcs)).toThrow(
      expect.objectContaining({ code: "FIELD_TYPE" })
    );
  });
  it("pure（FCW 0x8220）も DBCS のみ許可、SBCS を拒否", () => {
    const pure = field(FFW.ID_VALUE, "pure");
    expect(() => validateFieldContent("日本語", pure, dbcs)).not.toThrow();
    expect(() => validateFieldContent("日A", pure, dbcs)).toThrow(
      expect.objectContaining({ code: "FIELD_TYPE" })
    );
  });
  it("either（E 型）は SBCS だけ・DBCS だけのどちらも許可", () => {
    const either = field(FFW.ID_VALUE, "either");
    expect(() => validateFieldContent("ABC", either, dbcs)).not.toThrow();
    expect(() => validateFieldContent("日本", either, dbcs)).not.toThrow();
  });
  it("open（O 型）は SBCS/DBCS 混在を許可", () => {
    const open = field(FFW.ID_VALUE, "open");
    expect(() => validateFieldContent("A日B", open, dbcs)).not.toThrow();
  });
});

/**
 * **検証エラーの文言に、利用者が打った値を 1 文字も入れない。**
 *
 * この文言は `ws-handler` の catch を通って**そのままブラウザへ返る**
 * （`20260920-field-error-no-value` research F1-b。`sendError(code, err.message, fatal)`）。
 * 値は**マクロ由来の秘密**でもありうる——`resolveSecret` が復号した平文を欄へ書くので、
 * 型の合わない欄に当たると**復号済みの秘密が画面に出ていた**（同 research F1-a）。
 * `AGENTS.md`「秘密の扱い」の「API/ブラウザには平文も暗号文も返さない」。
 *
 * ~~`numeric field accepts digits only: "<値>"`~~ のように値を埋める形だったので、
 * **位置と理由だけ**に変えた。
 */
describe("validateFieldContent — 文言に値を入れない", () => {
  /** 秘密を模した文字列。**どの検証にも引っかかる**ように記号・英字・数字を混ぜる */
  const SECRET = "P@ssw0rd-1234";
  const at = { row: 20, col: 7 };

  /** 投げた例外を取り出す（投げなければ検査が空振りするので失敗させる） */
  function thrown(fn: () => void): { code: string; message: string } {
    try {
      fn();
    } catch (e) {
      return e as { code: string; message: string };
    }
    throw new Error("例外が投げられていない（この検査は空振りしている）");
  }

  it("数値専用: 値が含まれず、位置と理由が入る", () => {
    const e = thrown(() =>
      validateFieldContent(SECRET, field(FFW.ID_VALUE | FFW.SHIFT_NUMERIC_ONLY), sbcs, "", at)
    );
    expect(e.code).toBe("FIELD_TYPE");
    expect(e.message, "値が漏れていない").not.toContain(SECRET);
    expect(e.message).toBe("field at (20,7) accepts digits only");
  });

  it("英字専用: 値が含まれず、位置と理由が入る", () => {
    const e = thrown(() =>
      validateFieldContent(SECRET, field(FFW.ID_VALUE | FFW.SHIFT_ALPHA_ONLY), sbcs, "", at)
    );
    expect(e.message).not.toContain(SECRET);
    expect(e.message).toBe("field at (20,7) accepts alphabetic characters only");
  });

  it("DBCS 専用: 値が含まれず、位置と理由が入る", () => {
    const e = thrown(() =>
      validateFieldContent(SECRET, field(FFW.ID_VALUE, "only"), dbcs, "", at)
    );
    expect(e.message).not.toContain(SECRET);
    expect(e.message).toBe("field at (20,7) accepts double-byte characters only");
  });

  it("コードページ外: 値が含まれず、位置と CCSID が入る", () => {
    // CCSID 37（SBCS 英語）に全角は無い
    const e = thrown(() => validateFieldContent("秘密", field(FFW.ID_VALUE), sbcs, "", at));
    expect(e.message).not.toContain("秘密");
    expect(e.message).toMatch(/^field at \(20,7\) cannot hold characters outside CCSID /);
  });

  it("**値の記号も長さも入らない**（英数字は文言と重なるので別途 toBe で見る）", () => {
    const e = thrown(() =>
      validateFieldContent(SECRET, field(FFW.ID_VALUE | FFW.SHIFT_NUMERIC_ONLY), sbcs, "", at)
    );
    for (const ch of new Set([...SECRET])) {
      // 位置の数字（2/0/7）と理由の英字は文言に在るので、**値に固有の記号**で見る
      if (/[a-z0-9]/i.test(ch)) continue;
      expect(e.message, `値の文字 ${JSON.stringify(ch)} が漏れている`).not.toContain(ch);
    }
    expect(e.message).not.toContain(String(SECRET.length));
  });

  it("位置を渡さなければ省く（既存の呼び出しを壊さない）", () => {
    const e = thrown(() =>
      validateFieldContent(SECRET, field(FFW.ID_VALUE | FFW.SHIFT_NUMERIC_ONLY), sbcs)
    );
    expect(e.message).toBe("field accepts digits only");
  });
});
