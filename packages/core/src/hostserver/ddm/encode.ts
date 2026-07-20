/**
 * 物理レコードの各フィールドを、IBM i のバイト表現に変換する。
 *
 * ここが**この作業の真の難所**である（`20260718-hostserver-sql` の retro が
 * 「真の難所はバイト列の組み立てではなくデータ型変換」と記録している）。
 * 読み取り側（`db/db-decode.ts`）で一度通った道だが、**書き込みは逆変換で別の実装**になる。
 *
 * すべて純関数にしてあり、実機なしで単体テストできる。
 *
 * 参照: jtopenlite の `com.ibm.jtopenlite.ddm.DDMField` および `com.ibm.jtopenlite.Conv`
 * に対応する（逐語移植ではなく、バイト配置という事実に基づく書き起こし）。
 */
import { As400Error } from "../../errors.js";

/** EBCDIC の数字 0-9（0xF0-0xF9）。ゾーン/パック 10 進の構成要素 */
const EBCDIC_ZERO = 0xf0;
/** パック 10 進の符号ニブル。正 = 0xF（IBM i の既定）、負 = 0xD */
const PACKED_SIGN_POSITIVE = 0x0f;
const PACKED_SIGN_NEGATIVE = 0x0d;
/** ゾーン 10 進の負の符号ゾーン（最終バイトの上位ニブル） */
const ZONED_SIGN_NEGATIVE = 0xd0;

/**
 * 数値を「符号」と「位取りを適用した数字列」に分解する。
 *
 * **文字列として扱う**——`number` の丸めで下位桁を失わないため
 * （DECIMAL(31,0) のような桁数は double で表せない）。
 */
export function toDigits(
  value: number | bigint | string,
  precision: number,
  scale: number
): { negative: boolean; digits: string } {
  const raw = typeof value === "string" ? value.trim() : String(value);
  const m = /^([+-]?)(\d*)(?:\.(\d*))?$/.exec(raw);
  if (!m || (m[2] === "" && (m[3] ?? "") === "")) {
    throw new As400Error("CONFIG_ERROR", `数値として解釈できません: ${raw}`);
  }
  const negative = m[1] === "-";
  const intPart = m[2] ?? "";
  const fracRaw = m[3] ?? "";

  // 位取りに合わせて小数部を詰める / 切る。**切り捨てではなく拒否する**——
  // 黙って値を変えると、書き込んだ側は気づけない
  if (fracRaw.length > scale && /[1-9]/.test(fracRaw.slice(scale))) {
    throw new As400Error(
      "CONFIG_ERROR",
      `位取り ${scale} に収まらない小数部です: ${raw}（切り捨てはしない）`
    );
  }
  const frac = fracRaw.slice(0, scale).padEnd(scale, "0");
  const digits = `${intPart.replace(/^0+(?=\d)/, "")}${frac}`.padStart(precision, "0");
  if (digits.length > precision) {
    throw new As400Error("CONFIG_ERROR", `桁数 ${precision} に収まりません: ${raw}`);
  }
  return { negative, digits };
}

/**
 * パック 10 進（DECIMAL）。1 バイトに 2 桁、最終ニブルが符号。
 * 全体のバイト数は `floor(precision / 2) + 1`。
 */
export function encodePacked(
  value: number | bigint | string,
  precision: number,
  scale: number
): Uint8Array {
  const { negative, digits } = toDigits(value, precision, scale);
  const size = Math.floor(precision / 2) + 1;
  const out = new Uint8Array(size);
  // 全体は size*2 ニブル。**最後の 1 ニブルが符号**なので、桁はその手前まで（size*2-1）を使う。
  // 桁 i はニブル i に入り、ニブル n は byte(n>>1) の上位（n 偶数）／下位（n 奇数）に載る。
  const nibbles = digits.padStart(size * 2 - 1, "0");
  for (let n = 0; n < nibbles.length; n++) {
    const d = nibbles.charCodeAt(n) - 0x30;
    const byte = n >> 1;
    if (n % 2 === 0) out[byte] = (out[byte]! & 0x0f) | (d << 4);
    else out[byte] = (out[byte]! & 0xf0) | d;
  }
  out[size - 1] = (out[size - 1]! & 0xf0) | (negative ? PACKED_SIGN_NEGATIVE : PACKED_SIGN_POSITIVE);
  return out;
}

/**
 * ゾーン 10 進（NUMERIC）。1 バイトに 1 桁（EBCDIC の数字）。
 * 負数は**最終バイトの上位ニブルを 0xD** にする。
 */
export function encodeZoned(
  value: number | bigint | string,
  precision: number,
  scale: number
): Uint8Array {
  const { negative, digits } = toDigits(value, precision, scale);
  const out = new Uint8Array(precision);
  for (let i = 0; i < precision; i++) {
    out[i] = EBCDIC_ZERO + (digits.charCodeAt(i) - 0x30);
  }
  if (negative && precision > 0) {
    out[precision - 1] = (out[precision - 1]! & 0x0f) | ZONED_SIGN_NEGATIVE;
  }
  return out;
}

/** 2 / 4 / 8 バイトの符号付き整数（ビッグエンディアン） */
export function encodeInt(value: number | bigint | string, bytes: 2 | 4 | 8): Uint8Array {
  const v = typeof value === "bigint" ? value : BigInt(String(value).trim());
  const bits = BigInt(bytes * 8);
  const min = -(2n ** (bits - 1n));
  const max = 2n ** (bits - 1n) - 1n;
  if (v < min || v > max) {
    throw new As400Error("CONFIG_ERROR", `${bytes * 8} ビット整数に収まりません: ${String(value)}`);
  }
  const out = new Uint8Array(bytes);
  let rest = v < 0n ? v + 2n ** bits : v;
  for (let i = bytes - 1; i >= 0; i--) {
    out[i] = Number(rest & 0xffn);
    rest >>= 8n;
  }
  return out;
}

/**
 * 固定長の文字フィールド。**右を EBCDIC の空白（0x40）で詰める**。
 *
 * 長さを超える文字列は**切らずに拒否する**——黙って切ると、
 * 書き込んだ側は欠けたことに気づけない。
 *
 * **変換できない文字も拒否する**。コーデックは変換不能な文字を置換文字（SUB）にして
 * `substituted` で件数を返すが、これを見ずに書くと**壊れた値が静かに保存される**
 * （実機検証で、CCSID 37 のコーデックに日本語を渡して `` が 3 つ書き込まれた）。
 * DBCS を書きたい場合は DBCS 対応の CCSID のコーデックを渡すこと。
 */
export function encodeChar(
  value: string,
  length: number,
  encoder: (text: string) => { bytes: Uint8Array; substituted: number }
): Uint8Array {
  const { bytes, substituted } = encoder(value);
  if (substituted > 0) {
    throw new As400Error(
      "CONFIG_ERROR",
      `このコードページで表せない文字が ${substituted} 個あります: ${value}` +
        `（置換文字を書き込むと壊れた値が残るため拒否する）`
    );
  }
  if (bytes.length > length) {
    throw new As400Error(
      "CONFIG_ERROR",
      `文字フィールドの長さ ${length} を超えます（${bytes.length} バイト）: ${value}`
    );
  }
  const out = new Uint8Array(length).fill(0x40); // EBCDIC の空白
  out.set(bytes, 0);
  return out;
}
