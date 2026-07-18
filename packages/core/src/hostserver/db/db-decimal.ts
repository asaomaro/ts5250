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
import { Tn5250Error } from "../../errors.js";

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
    throw new Tn5250Error(
      "PROTOCOL_ERROR",
      `${what} out of range (offset ${offset}, need ${len}, have ${data.length})`
    );
  }
}
