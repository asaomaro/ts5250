/**
 * パック 10 進数 / ゾーン 10 進数 → 文字列。
 *
 * **`number` を経由しない**——JavaScript の `number` は 2^53 を超えると精度を失い、
 * DECIMAL(11,2) のような金額列で静かに誤った値になる。原典も文字列変換の経路を持つ。
 *
 * **符号の位置がパックとゾーンで違う**ので取り違えに注意:
 *   パック … 最終バイトの【下位ニブル】
 *   ゾーン … 最終バイトの【上位ニブル】
 *
 * 参照: JTOpen(jtopenlite) の Conv.packedDecimalToString / zonedDecimalToString に対応する。
 */
import { As400Error } from "@ts5250/base";

/** 負を表す符号ニブル。それ以外（0x0C / 0x0F 等）は正 */
const NEGATIVE_SIGNS: ReadonlySet<number> = new Set([0x0b, 0x0d]);

/** パック 10 進数のバイト長（桁数を奇数へ切り上げてから /2 + 1） */
export function packedByteLength(numDigits: number): number {
  const odd = numDigits % 2 === 0 ? numDigits + 1 : numDigits;
  return Math.floor(odd / 2) + 1;
}

/**
 * パック 10 進数 → 文字列。1 バイトに 2 桁、最終ニブルが符号。
 *
 * @param numDigits 全体の桁数（precision）
 * @param scale 小数点以下の桁数
 */
export function packedDecimalToString(
  data: Uint8Array,
  offset: number,
  numDigits: number,
  scale: number
): string {
  const digits = numDigits % 2 === 0 ? numDigits + 1 : numDigits;
  const len = Math.floor(digits / 2) + 1;
  assertRange(data, offset, len, "packed decimal");

  const sign = data[offset + len - 1]! & 0x0f;
  const negative = NEGATIVE_SIGNS.has(sign);

  // ニブルを順に読む（先頭は桁数が奇数のとき上位から）
  const nibbles: number[] = [];
  let pos = offset;
  let high = digits % 2 !== 0;
  for (let i = 0; i < digits; i++) {
    nibbles.push(high ? (data[pos]! >> 4) & 0x0f : data[pos]! & 0x0f);
    if (high) high = false;
    else {
      high = true;
      pos++;
    }
  }
  return assemble(nibbles, scale, negative);
}

/**
 * ゾーン 10 進数 → 文字列。1 バイトに 1 桁（下位ニブル）、
 * **最終バイトの上位ニブル**が符号。
 *
 * @param numDigits 全体の桁数（＝バイト長）
 * @param scale 小数点以下の桁数
 */
export function zonedDecimalToString(
  data: Uint8Array,
  offset: number,
  numDigits: number,
  scale: number
): string {
  assertRange(data, offset, numDigits, "zoned decimal");

  const sign = (data[offset + numDigits - 1]! >> 4) & 0x0f;
  const negative = NEGATIVE_SIGNS.has(sign);

  const nibbles: number[] = [];
  for (let i = 0; i < numDigits; i++) {
    nibbles.push(data[offset + i]! & 0x0f);
  }
  return assemble(nibbles, scale, negative);
}

/** 桁の並びを符号・小数点付きの文字列にする（前置ゼロは落とす） */
function assemble(nibbles: readonly number[], scale: number, negative: boolean): string {
  const intDigits = nibbles.length - scale;
  let intPart = "";
  for (let i = 0; i < intDigits; i++) {
    const n = nibbles[i]!;
    if (intPart.length > 0 || n !== 0) intPart += String(n);
  }
  if (intPart.length === 0) intPart = "0";

  let out = negative ? `-${intPart}` : intPart;
  if (scale > 0) {
    let frac = "";
    for (let i = intDigits; i < nibbles.length; i++) frac += String(nibbles[i]!);
    out += `.${frac}`;
  }
  // -0 は 0 に寄せる（符号だけ負でゼロの表現を作らない）
  if (negative && /^-0(\.0*)?$/.test(out)) out = out.slice(1);
  return out;
}

function assertRange(data: Uint8Array, offset: number, len: number, what: string): void {
  if (offset < 0 || offset + len > data.length) {
    throw new As400Error(
      "PROTOCOL_ERROR",
      `${what} out of range (offset ${offset}, need ${len}, have ${data.length})`
    );
  }
}

// ---- 書く向き（プログラム呼び出しの入力パラメータ用） ----

/**
 * 数値を表す文字列を分解する。**`number` を経由しない**（読む向きと同じ理由）。
 *
 * `"-12.34"` → `{ negative: true, digits: "1234", scale: 2 }`
 */
function parseNumeric(text: string): { negative: boolean; digits: string; scale: number } {
  const m = /^\s*([+-]?)(\d*)(?:\.(\d*))?\s*$/u.exec(text);
  if (!m || (m[2] === "" && (m[3] ?? "") === "")) {
    throw new As400Error("CONFIG_ERROR", `数値として読めません: ${JSON.stringify(text)}`);
  }
  const frac = m[3] ?? "";
  return { negative: m[1] === "-", digits: `${m[2]}${frac}`, scale: frac.length };
}

/** 桁数と小数位に合わせて digits を伸縮する（あふれたら拒否） */
function fitDigits(text: string, numDigits: number, scale: number): { negative: boolean; digits: string } {
  const n = parseNumeric(text);
  let digits = n.digits;
  if (n.scale < scale) digits += "0".repeat(scale - n.scale);
  else if (n.scale > scale) {
    // **黙って丸めない。** 精度が落ちたことに気づけないほうが危ない
    const dropped = digits.slice(digits.length - (n.scale - scale));
    if (/[^0]/u.test(dropped)) {
      throw new As400Error(
        "CONFIG_ERROR",
        `小数 ${scale} 桁に収まりません: ${JSON.stringify(text)}（切り捨てると値が変わる）`
      );
    }
    digits = digits.slice(0, digits.length - (n.scale - scale));
  }
  digits = digits.replace(/^0+(?=\d)/u, "");
  if (digits.length > numDigits) {
    throw new As400Error("CONFIG_ERROR", `${numDigits} 桁に収まりません: ${JSON.stringify(text)}`);
  }
  return { negative: n.negative, digits: digits.padStart(numDigits, "0") };
}

/** 正の符号ニブル（IBM i の既定）。負は 0x0D */
const SIGN_POSITIVE = 0x0f;
const SIGN_NEGATIVE = 0x0d;

/**
 * 文字列 → パック 10 進数。`packedDecimalToString` の逆。
 *
 * **往復で値が変わらないこと**を検査で固定してある——符号ニブルと奇数桁の詰め方は
 * 取り違えやすく、間違えても「それらしいバイト列」になるので気づきにくい。
 */
export function stringToPackedDecimal(text: string, numDigits: number, scale: number): Uint8Array {
  const { negative, digits } = fitDigits(text, numDigits, scale);
  // 読む向きと同じく、桁数が偶数なら 1 つ足して奇数にする
  const odd = numDigits % 2 === 0 ? numDigits + 1 : numDigits;
  const padded = digits.padStart(odd, "0");
  const out = new Uint8Array(Math.floor(odd / 2) + 1);
  let pos = 0;
  let high = true;
  for (const ch of padded) {
    const v = ch.charCodeAt(0) - 48;
    if (high) out[pos] = v << 4;
    else out[pos] = (out[pos] ?? 0) | v;
    if (!high) pos++;
    high = !high;
  }
  // **最終ニブルが符号**（上位ニブルには最後の桁が入っている）
  out[out.length - 1] = (out[out.length - 1]! & 0xf0) | (negative ? SIGN_NEGATIVE : SIGN_POSITIVE);
  return out;
}

/**
 * 文字列 → ゾーン 10 進数。`zonedDecimalToString` の逆。
 *
 * 1 バイト 1 桁（上位ニブルは 0xF）。**最終バイトの上位ニブルが符号**——
 * パックと位置が違うので取り違えに注意（読む向きの注記と同じ）。
 */
export function stringToZonedDecimal(text: string, numDigits: number, scale: number): Uint8Array {
  const { negative, digits } = fitDigits(text, numDigits, scale);
  const out = new Uint8Array(numDigits);
  for (let i = 0; i < numDigits; i++) {
    out[i] = 0xf0 | (digits.charCodeAt(i) - 48);
  }
  out[numDigits - 1] = ((negative ? SIGN_NEGATIVE : SIGN_POSITIVE) << 4) | (out[numDigits - 1]! & 0x0f);
  return out;
}
