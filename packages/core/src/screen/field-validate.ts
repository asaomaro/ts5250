import { As400Error } from "../errors.js";
import { FFW } from "../protocol/constants.js";
import { isRawSentinel } from "./attr-sentinel.js";
import type { Codec } from "@as400web/ebcdic";
import type { InternalField } from "./buffer.js";

/**
 * フィールド入力値の内容検証（FFW シフト種別・DBCS 種別・コードページ許容文字）。
 * 違反は FIELD_TYPE エラー（decisions D4）。長さ検証は呼び出し側で別途行う。
 *
 * **これは実機に無い層。** 実機の端末はシフト種別を**打鍵のときだけ**見て、バッファの中身は
 * そのまま送る（GNU tn5250 の `tn5250_field_valid_char` の呼び出し元は打鍵処理の 1 か所だけ）。
 * ここが要るのは MCP・マクロ・ペーストという**実機に無い入口**を守るため。
 *
 * @param current その欄の**現在値**（ホストが書いた内容）。ここに含まれる文字は違反にしない。
 *   数値欄に `EDTCDE` / `EDTWRD` を書くと `$` `*` `/` `CR` などが**欄の中に入って**来る
 *   （実機で実測。用途 B でも書けて、EDTMSK のような分解は起きない）。
 *   弾いてしまうと**ホスト自身が書いた値を送り返せず、画面ごと送信できなくなる**。
 */
export function validateFieldContent(
  value: string,
  field: InternalField,
  codec: Codec,
  current = ""
): void {
  const shift = field.ffw & FFW.SHIFT_MASK;
  // **センチネル（生バイトを運ぶ印）は利用者が打った文字ではない**ので型検証の対象から外す。
  // 埋め込み画面属性（SEU の色付きソース）と Dup 文字（0x1C）がこれに当たる。
  // 外さないと、数値欄で Dup を押した瞬間に「数字しか入らない」で自分の入力を弾いてしまう。
  const typed = [...value].filter((ch) => !isRawSentinel(ch)).join("");
  // **ホストが置いた文字は弾かない**（上の `current` 参照）。許容集合を一律に広げると
  // ただの誤入力まで通ってしまうので、「その欄に元からある文字」だけを通す
  const fromHost = new Set([...current].filter((ch) => !isRawSentinel(ch)));
  const checked = [...typed].filter((ch) => !fromHost.has(ch)).join("");

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
    // 従来どおり FIELD_TYPE で拒否される——**ただし現在値に空白が含まれる欄は除く**
    // （`EDTWRD` が桁区切りに空白を使うことがあり、それはホストが書いた文字なので通す）。
    if (!allowed.test(checked.trim())) {
      throw new As400Error("FIELD_TYPE", `numeric field accepts digits only: ${JSON.stringify(value)}`);
    }
  }

  // 英字専用（DDS 35 桁の `X`）。**数字を弾く**。許容集合は参照実装 2 つが一致している
  // （GNU tn5250 `field.c:404` / tn5250j `Screen5250.java:1372`: 英字・`,`・`.`・`-`・空白）。
  //
  // **キーボード入力不可（`SHIFT_IO` 0x0600）はここで弾かない。** 「キーボードから入力できない」
  // という制約であって値そのものの制約ではないので、送信時検証（＝ペースト・マクロ・MCP も通る
  // 経路）で弾くと入力手段ごと塞いでしまう。判定は端末側（web-ui の打鍵時）で行う。
  if (shift === FFW.SHIFT_ALPHA_ONLY && !/^[A-Za-z,.\- ]*$/.test(checked)) {
    throw new As400Error("FIELD_TYPE", `alphabetic-only field rejects: ${JSON.stringify(value)}`);
  }

  // DBCS 種別（pure=DBCS のみ / open=SBCS+DBCS / either=どちらか）
  if (field.dbcsType === "pure") {
    for (const ch of typed) {
      if (!isDbcsChar(ch, codec)) {
        throw new As400Error("FIELD_TYPE", `DBCS-only (pure) field rejects SBCS char: ${JSON.stringify(ch)}`);
      }
    }
  }

  // コードページ許容文字: マップ不能文字（encode で SUB 置換されるもの）は拒否
  // （例: CCSID 930 は英小文字が SBCS 表に無く入力不可）
  // センチネルは codec を通さず生バイトで送るので、ここでも除いた文字列で判定する
  // （私用面の符号なので、通すと外字として encode されたり SUB に化けたりして誤判定になる）
  const { substituted } = codec.encode(typed);
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
