import { Tn5250Error } from "../errors.js";
import { FFW } from "../protocol/constants.js";
import type { Codec } from "../codec/codec.js";
import type { InternalField } from "./buffer.js";

/**
 * フィールド入力値の内容検証（FFW シフト種別・DBCS 種別・コードページ許容文字）。
 * 違反は FIELD_TYPE エラー（decisions D4）。長さ検証は呼び出し側で別途行う。
 */
export function validateFieldContent(value: string, field: InternalField, codec: Codec): void {
  const shift = field.ffw & FFW.SHIFT_MASK;

  // 数値専用（数字・符号・小数点のみ）
  const numericOnly =
    shift === FFW.SHIFT_NUMERIC_ONLY ||
    shift === FFW.SHIFT_DIGITS_ONLY ||
    shift === FFW.SHIFT_SIGNED_NUMERIC;
  if (numericOnly) {
    const allowed = shift === FFW.SHIFT_DIGITS_ONLY ? /^[0-9]*$/ : /^[0-9.,+-]*$/;
    if (!allowed.test(value)) {
      throw new Tn5250Error("FIELD_TYPE", `numeric field accepts digits only: ${JSON.stringify(value)}`);
    }
  }

  // DBCS 種別（pure=DBCS のみ / open=SBCS+DBCS / either=どちらか）
  if (field.dbcsType === "pure") {
    for (const ch of value) {
      if (!isDbcsChar(ch, codec)) {
        throw new Tn5250Error("FIELD_TYPE", `DBCS-only (pure) field rejects SBCS char: ${JSON.stringify(ch)}`);
      }
    }
  }

  // コードページ許容文字: マップ不能文字（encode で SUB 置換されるもの）は拒否
  // （例: CCSID 930 は英小文字が SBCS 表に無く入力不可）
  const { substituted } = codec.encode(value);
  if (substituted > 0) {
    throw new Tn5250Error(
      "FIELD_TYPE",
      `value contains characters not representable in CCSID ${codec.ccsid}`
    );
  }
}

/** その文字が現在のコードページで DBCS（2 バイト）として表現されるか */
function isDbcsChar(ch: string, codec: Codec): boolean {
  if (!codec.encodeDbcsChar) return false;
  const cp = ch.codePointAt(0);
  return cp !== undefined && codec.encodeDbcsChar(cp) !== undefined;
}
