import { As400Error } from "../errors.js";
import { FFW } from "../protocol/constants.js";
import type { Codec } from "@as400web/ebcdic";
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
    // **前後の空白は桁合わせの padding として通す。** FFW の ADJUST（右寄せ・空白埋め）と
    // signed-num の既定右寄せは端末側で値の左に空白を作るため、ここで弾くと
    // 自分で整形した値を自分で送れなくなる。埋め込みの空白（"1 2"）は trim で消えないので
    // 従来どおり FIELD_TYPE で拒否される。
    if (!allowed.test(value.trim())) {
      throw new As400Error("FIELD_TYPE", `numeric field accepts digits only: ${JSON.stringify(value)}`);
    }
  }

  // 英字専用（DDS 35 桁の `X`）。**数字を弾く**。許容集合は参照実装 2 つが一致している
  // （GNU tn5250 `field.c:404` / tn5250j `Screen5250.java:1372`: 英字・`,`・`.`・`-`・空白）。
  //
  // **キーボード入力不可（`SHIFT_IO` 0x0600）はここで弾かない。** 「キーボードから入力できない」
  // という制約であって値そのものの制約ではないので、送信時検証（＝ペースト・マクロ・MCP も通る
  // 経路）で弾くと入力手段ごと塞いでしまう。判定は端末側（web-ui の打鍵時）で行う。
  if (shift === FFW.SHIFT_ALPHA_ONLY && !/^[A-Za-z,.\- ]*$/.test(value)) {
    throw new As400Error("FIELD_TYPE", `alphabetic-only field rejects: ${JSON.stringify(value)}`);
  }

  // DBCS 種別（pure=DBCS のみ / open=SBCS+DBCS / either=どちらか）
  if (field.dbcsType === "pure") {
    for (const ch of value) {
      if (!isDbcsChar(ch, codec)) {
        throw new As400Error("FIELD_TYPE", `DBCS-only (pure) field rejects SBCS char: ${JSON.stringify(ch)}`);
      }
    }
  }

  // コードページ許容文字: マップ不能文字（encode で SUB 置換されるもの）は拒否
  // （例: CCSID 930 は英小文字が SBCS 表に無く入力不可）
  const { substituted } = codec.encode(value);
  if (substituted > 0) {
    throw new As400Error(
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
