import { As400Error } from "@ts5250/base";
import { FFW } from "../protocol/constants.js";
import { isRawSentinel } from "./attr-sentinel.js";
import type { Codec } from "@ts5250/ebcdic";
import type { InternalField } from "./buffer.js";
import type { DbcsFieldType } from "./types.js";

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
    // **数値専用（`SHIFT_NUMERIC_ONLY`/`SHIFT_SIGNED_NUMERIC`）は埋め込みの空白も許容する**
    // ——ACS のデコンパイル済みコア（`Field5250.checkNumericOnlyChar()`）が
    // 数字・空白・カンマ・ハイフン・ピリオド・プラスを位置を問わず許容しており、
    // それに合わせた（`.aidev/works/20260915-acs-field-validation-audit`
    // research.md F2）。**`SHIFT_DIGITS_ONLY` は対象外**——ACS の
    // `checkDigitsOnlyChar()` は数字以外（空白を含む）を拒否するため、従来どおり
    // 埋め込みの空白も拒否する（同 research.md F3、decisions.md D4）。
    const allowed = shift === FFW.SHIFT_DIGITS_ONLY ? /^[0-9]*$/ : /^[0-9 .,+-]*$/;
    // **前後の空白は桁合わせの padding として通す。** FFW の ADJUST（右寄せ・空白埋め）と
    // signed-num の既定右寄せは端末側で値の左に空白を作るため、ここで弾くと
    // 自分で整形した値を自分で送れなくなる。`SHIFT_DIGITS_ONLY` の埋め込みの空白
    // （"1 2"）は trim で消えないので従来どおり FIELD_TYPE で拒否される
    // ——**ただし現在値に空白が含まれる欄は除く**（`EDTWRD` が桁区切りに空白を
    // 使うことがあり、それはホストが書いた文字なので通す）。
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

  // DBCS 種別（only / pure=DBCS のみ / open=SBCS+DBCS / either=どちらか）。
  // **`only`（0x8200・DDS の J 型）も DBCS のみ。** 以前は 0x8200 を "pure" と呼んでいたので
  // "pure" だけを見ていた——4 値化（`DbcsFieldType`）で J 型が "only" になったため、両方を拾う
  if (isDbcsOnly(field.dbcsType)) {
    for (const ch of typed) {
      if (!isDbcsChar(ch, codec)) {
        throw new As400Error("FIELD_TYPE", `DBCS-only (${field.dbcsType}) field rejects SBCS char: ${JSON.stringify(ch)}`);
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

/**
 * **DBCS しか入らない欄か**（`only`＝0x8200 の J 型 / `pure`＝0x8220）。
 * `open` / `either` は SBCS も通す。web-ui の打鍵時検査（`fieldValidate.ts`）も同じ判定を使う。
 */
export function isDbcsOnly(dbcsType: DbcsFieldType | undefined): boolean {
  return dbcsType === "only" || dbcsType === "pure";
}

/** その文字が現在のコードページで DBCS（2 バイト）として表現されるか */
function isDbcsChar(ch: string, codec: Codec): boolean {
  if (!codec.encodeDbcsChar) return false;
  const cp = ch.codePointAt(0);
  return cp !== undefined && codec.encodeDbcsChar(cp) !== undefined;
}

/**
 * **自己点検欄の検算**（DDS の `CHECK(M10)` / `CHECK(M11)`。FCW 0xB1A0 / 0xB140）。
 *
 * ACS `Field5250.checkModulusField()` / `modulusCheck()` をそのまま写した:
 * - **末尾 1 桁がチェック・ディジット**。残りを右から重み付けして合計する
 * - `mod10`: 重みは右端から 1,2 の交互。2 倍した桁が 10 以上なら 9 を引く（Luhn と同じ）
 * - `mod11`: 重みは右端から 2,3,4,5,6,7 の繰り返し（7 の次は 2 へ戻る）
 * - 合計 % 法 が 0 ならチェック・ディジットも 0 のとき合格、
 *   0 でなければ「余り + チェック・ディジット == 法」のとき合格
 * - **全桁が 0（または空）なら検査しない**（ACS も全桁を OR して下位 4 ビットが 0 なら素通し）
 *
 * 桁の値は ACS と同じく**文字コードの下位 4 ビット**で取る（EBCDIC の `F0`〜`F9` でも
 * ASCII の `30`〜`39` でも同じ値になる）。9 を超えたものは 0 として数える。
 *
 * **ホストはこれを検証しない。** 端末が止めなければ誤入力がそのまま通る
 * （`MANDATORY_ENTER` / `MANDATORY_FILL` と同じ性質）。
 */
export function selfCheckDigitOk(value: string, kind: "mod10" | "mod11"): boolean {
  const digits = value.trim();
  if (digits.length < 2) return true; // 検算する余地が無い（ACS も長さ 1 以下では検査しない）
  const nibble = (ch: string): number => {
    const d = ch.charCodeAt(0) & 0x0f;
    return d > 9 ? 0 : d;
  };
  const checkDigit = nibble(digits[digits.length - 1]!);
  const body = digits.slice(0, -1);
  const modulus = kind === "mod10" ? 10 : 11;
  let sum = 0;
  let weight = 1;
  let orAll = digits[digits.length - 1]!.charCodeAt(0);
  for (let i = body.length - 1; i >= 0; i--) {
    orAll |= body.charCodeAt(i);
    const d = nibble(body[i]!);
    if (kind === "mod10") {
      if (weight === 1) {
        weight = 2;
        if (d > 4) sum -= 9;
      } else {
        weight = 1;
      }
    } else {
      weight = weight === 7 ? 2 : weight + 1;
    }
    sum += weight * d;
  }
  if ((orAll & 0x0f) === 0) return true; // 全桁 0 / 空欄は検査しない
  const rem = sum % modulus;
  if (rem === 0) return checkDigit === 0;
  return rem + checkDigit === modulus;
}
