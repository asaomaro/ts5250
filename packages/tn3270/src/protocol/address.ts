import { As400Error } from "@ts5250/base";

/**
 * バッファアドレスの符号化・復号（12 / 14 / 16 ビット）。**純関数**。
 *
 * 5250 の SBA が「1 始まりの行・桁を直値で置く」（`docs/PROTOCOL.md` §5）のに対し、
 * **3270 は画面先頭からの通し番号を 2 バイトに詰める**。しかも詰め方が 3 通りある。
 *
 * **12 ビット形式**が基本で、6 ビットずつを下の 64 要素表で「EBCDIC の図形文字」に写す。
 * 制御コードと衝突しないバイトだけを使うための工夫で、**表引きが必須**（単純なシフトでは戻せない）。
 *
 * 実測（`negotiation-hercules.trc`）: `11 40 40` → 0、`11 c1 50` → 80（2 行目 1 桁）。
 * 表の先頭が 0x40 で、`c1`=index 1・`50`=index 16 → 1*64+16 = 80。計算が合う。
 */

/** 6 ビット値 → バイト（12 ビット形式で使う表） */
const CODE: readonly number[] = [
  0x40, 0xc1, 0xc2, 0xc3, 0xc4, 0xc5, 0xc6, 0xc7, 0xc8, 0xc9, 0x4a, 0x4b, 0x4c, 0x4d, 0x4e, 0x4f,
  0x50, 0xd1, 0xd2, 0xd3, 0xd4, 0xd5, 0xd6, 0xd7, 0xd8, 0xd9, 0x5a, 0x5b, 0x5c, 0x5d, 0x5e, 0x5f,
  0x60, 0x61, 0xe2, 0xe3, 0xe4, 0xe5, 0xe6, 0xe7, 0xe8, 0xe9, 0x6a, 0x6b, 0x6c, 0x6d, 0x6e, 0x6f,
  0xf0, 0xf1, 0xf2, 0xf3, 0xf4, 0xf5, 0xf6, 0xf7, 0xf8, 0xf9, 0x7a, 0x7b, 0x7c, 0x7d, 0x7e, 0x7f
];

/** バイト → 6 ビット値（CODE の逆引き。表引きなので逆表が要る） */
const DECODE = new Map<number, number>(CODE.map((b, i) => [b, i]));

/** 12 ビット形式で表せる最大アドレス（4,096 桁）。これを超える画面は 16 ビット形式を使う */
export const MAX_12BIT = 4096;

/**
 * アドレス 2 バイトを復号する。
 *
 * **形式の判定は先頭バイトの上位 2 ビット**で行う:
 * - `00` → 14 ビット形式（下位 6 ビット × 2 をそのまま連結）
 * - それ以外 → 12 ビット形式（CODE 表で引く）
 *
 * 16 ビット形式は「12 ビットで表せない画面」でのみ現れるので、
 * **画面サイズを渡して呼び分ける**（`bufferSize` が 4,096 を超えるときだけ 16 ビットとみなす）。
 */
export function decodeAddress(hi: number, lo: number, bufferSize = MAX_12BIT): number {
  if (bufferSize > MAX_12BIT) {
    // 16 ビット形式: 2 バイトをそのまま連結する
    return ((hi << 8) | lo) & 0xffff;
  }
  if ((hi & 0xc0) === 0x00) {
    // 14 ビット形式: 各バイトの下位 6 ビット
    return ((hi & 0x3f) << 6) | (lo & 0x3f);
  }
  const h = DECODE.get(hi);
  const l = DECODE.get(lo);
  if (h === undefined || l === undefined) {
    throw new As400Error(
      "PROTOCOL_ERROR",
      `invalid 12-bit buffer address bytes (0x${hi.toString(16)} 0x${lo.toString(16)})`
    );
  }
  return (h << 6) | l;
}

/**
 * アドレスを 2 バイトへ符号化する。
 *
 * **こちらから送るときは 12 ビット形式を使う**（`bufferSize` が 4,096 を超えるときだけ 16 ビット）。
 * 14 ビット形式は受信側でしか現れない——ホストが使う分には読めればよく、
 * 送り分ける理由が無い（12 ビットで表せる範囲なら 12 ビットが通る）。
 */
export function encodeAddress(addr: number, bufferSize = MAX_12BIT): [number, number] {
  if (bufferSize > MAX_12BIT) {
    return [(addr >> 8) & 0xff, addr & 0xff];
  }
  if (addr < 0 || addr >= MAX_12BIT) {
    throw new As400Error("PROTOCOL_ERROR", `buffer address out of 12-bit range: ${addr}`);
  }
  return [CODE[(addr >> 6) & 0x3f]!, CODE[addr & 0x3f]!];
}

/** 通し番号 → 1 始まりの行・桁 */
export function toRowCol(addr: number, cols: number): { row: number; col: number } {
  return { row: Math.floor(addr / cols) + 1, col: (addr % cols) + 1 };
}

/** 1 始まりの行・桁 → 通し番号 */
export function fromRowCol(row: number, col: number, cols: number): number {
  return (row - 1) * cols + (col - 1);
}
