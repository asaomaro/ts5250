/**
 * DES（Data Encryption Standard）の 1 ブロック暗号化。
 *
 * **なぜ自前実装か**: この層は Node 非依存（Web Crypto の標準グローバルのみ）に保つが、
 * Web Crypto に DES は無い（危殆化したため）。IBM i のパスワードレベル 0/1 の認証は
 * DES ベースの置換値を要求するので（`password.ts` の `passwordSubstituteDes`）、
 * ここに教科書どおりの DES を置く。**用途は認証の置換値生成のみ**で、データ暗号化には使わない。
 *
 * 実装は FIPS 46-3 の標準テーブル（IP/FP/E/P/PC1/PC2/S-box/シフト）に基づく。
 * 正しさは (1) FIPS の既知解テスト (2) 参照実装（jtopenlite EncryptPassword）との
 * 差分テストで固定する（`des.test.ts` / `password.test.ts`）。
 */

/** 初期転置 IP */
const IP = [
  58, 50, 42, 34, 26, 18, 10, 2, 60, 52, 44, 36, 28, 20, 12, 4,
  62, 54, 46, 38, 30, 22, 14, 6, 64, 56, 48, 40, 32, 24, 16, 8,
  57, 49, 41, 33, 25, 17, 9, 1, 59, 51, 43, 35, 27, 19, 11, 3,
  61, 53, 45, 37, 29, 21, 13, 5, 63, 55, 47, 39, 31, 23, 15, 7
];
/** 最終転置 FP（= IP の逆） */
const FP = [
  40, 8, 48, 16, 56, 24, 64, 32, 39, 7, 47, 15, 55, 23, 63, 31,
  38, 6, 46, 14, 54, 22, 62, 30, 37, 5, 45, 13, 53, 21, 61, 29,
  36, 4, 44, 12, 52, 20, 60, 28, 35, 3, 43, 11, 51, 19, 59, 27,
  34, 2, 42, 10, 50, 18, 58, 26, 33, 1, 41, 9, 49, 17, 57, 25
];
/** 拡大転置 E（32 → 48） */
const E = [
  32, 1, 2, 3, 4, 5, 4, 5, 6, 7, 8, 9, 8, 9, 10, 11, 12, 13, 12, 13, 14, 15, 16, 17,
  16, 17, 18, 19, 20, 21, 20, 21, 22, 23, 24, 25, 24, 25, 26, 27, 28, 29, 28, 29, 30, 31, 32, 1
];
/** 転置 P（32 → 32） */
const P = [
  16, 7, 20, 21, 29, 12, 28, 17, 1, 15, 23, 26, 5, 18, 31, 10,
  2, 8, 24, 14, 32, 27, 3, 9, 19, 13, 30, 6, 22, 11, 4, 25
];
/** 鍵転置 PC1（64 → 56、パリティビットを落とす） */
const PC1 = [
  57, 49, 41, 33, 25, 17, 9, 1, 58, 50, 42, 34, 26, 18, 10, 2, 59, 51, 43, 35, 27, 19, 11, 3,
  60, 52, 44, 36, 63, 55, 47, 39, 31, 23, 15, 7, 62, 54, 46, 38, 30, 22, 14, 6, 61, 53, 45, 37,
  29, 21, 13, 5, 28, 20, 12, 4
];
/** 鍵転置 PC2（56 → 48） */
const PC2 = [
  14, 17, 11, 24, 1, 5, 3, 28, 15, 6, 21, 10, 23, 19, 12, 4, 26, 8, 16, 7, 27, 20, 13, 2,
  41, 52, 31, 37, 47, 55, 30, 40, 51, 45, 33, 48, 44, 49, 39, 56, 34, 53, 46, 42, 50, 36, 29, 32
];
/** 各ラウンドの左回転量 */
const SHIFTS = [1, 1, 2, 2, 2, 2, 2, 2, 1, 2, 2, 2, 2, 2, 2, 1];
/** S-box S1〜S8（各 4×16） */
const S = [
  [14, 4, 13, 1, 2, 15, 11, 8, 3, 10, 6, 12, 5, 9, 0, 7, 0, 15, 7, 4, 14, 2, 13, 1, 10, 6, 12, 11, 9, 5, 3, 8,
    4, 1, 14, 8, 13, 6, 2, 11, 15, 12, 9, 7, 3, 10, 5, 0, 15, 12, 8, 2, 4, 9, 1, 7, 5, 11, 3, 14, 10, 0, 6, 13],
  [15, 1, 8, 14, 6, 11, 3, 4, 9, 7, 2, 13, 12, 0, 5, 10, 3, 13, 4, 7, 15, 2, 8, 14, 12, 0, 1, 10, 6, 9, 11, 5,
    0, 14, 7, 11, 10, 4, 13, 1, 5, 8, 12, 6, 9, 3, 2, 15, 13, 8, 10, 1, 3, 15, 4, 2, 11, 6, 7, 12, 0, 5, 14, 9],
  [10, 0, 9, 14, 6, 3, 15, 5, 1, 13, 12, 7, 11, 4, 2, 8, 13, 7, 0, 9, 3, 4, 6, 10, 2, 8, 5, 14, 12, 11, 15, 1,
    13, 6, 4, 9, 8, 15, 3, 0, 11, 1, 2, 12, 5, 10, 14, 7, 1, 10, 13, 0, 6, 9, 8, 7, 4, 15, 14, 3, 11, 5, 2, 12],
  [7, 13, 14, 3, 0, 6, 9, 10, 1, 2, 8, 5, 11, 12, 4, 15, 13, 8, 11, 5, 6, 15, 0, 3, 4, 7, 2, 12, 1, 10, 14, 9,
    10, 6, 9, 0, 12, 11, 7, 13, 15, 1, 3, 14, 5, 2, 8, 4, 3, 15, 0, 6, 10, 1, 13, 8, 9, 4, 5, 11, 12, 7, 2, 14],
  [2, 12, 4, 1, 7, 10, 11, 6, 8, 5, 3, 15, 13, 0, 14, 9, 14, 11, 2, 12, 4, 7, 13, 1, 5, 0, 15, 10, 3, 9, 8, 6,
    4, 2, 1, 11, 10, 13, 7, 8, 15, 9, 12, 5, 6, 3, 0, 14, 11, 8, 12, 7, 1, 14, 2, 13, 6, 15, 0, 9, 10, 4, 5, 3],
  [12, 1, 10, 15, 9, 2, 6, 8, 0, 13, 3, 4, 14, 7, 5, 11, 10, 15, 4, 2, 7, 12, 9, 5, 6, 1, 13, 14, 0, 11, 3, 8,
    9, 14, 15, 5, 2, 8, 12, 3, 7, 0, 4, 10, 1, 13, 11, 6, 4, 3, 2, 12, 9, 5, 15, 10, 11, 14, 1, 7, 6, 0, 8, 13],
  [4, 11, 2, 14, 15, 0, 8, 13, 3, 12, 9, 7, 5, 10, 6, 1, 13, 0, 11, 7, 4, 9, 1, 10, 14, 3, 5, 12, 2, 15, 8, 6,
    1, 4, 11, 13, 12, 3, 7, 14, 10, 15, 6, 8, 0, 5, 9, 2, 6, 11, 13, 8, 1, 4, 10, 7, 9, 5, 0, 15, 14, 2, 3, 12],
  [13, 2, 8, 4, 6, 15, 11, 1, 10, 9, 3, 14, 5, 0, 12, 7, 1, 15, 13, 8, 10, 3, 7, 4, 12, 5, 6, 11, 0, 14, 9, 2,
    7, 11, 4, 1, 9, 12, 14, 2, 0, 6, 10, 13, 15, 3, 5, 8, 2, 1, 14, 7, 4, 10, 8, 13, 15, 12, 9, 0, 3, 5, 6, 11]
];

/** 8 バイトを 64 ビット配列（MSB 先頭、1 ビット/要素）に展開する */
function toBits(bytes: Uint8Array): Uint8Array {
  const bits = new Uint8Array(64);
  for (let i = 0; i < 8; i++) {
    for (let b = 0; b < 8; b++) {
      bits[i * 8 + b] = (bytes[i]! >> (7 - b)) & 1;
    }
  }
  return bits;
}

/** 64 ビット配列を 8 バイトへ戻す */
function fromBits(bits: Uint8Array): Uint8Array {
  const out = new Uint8Array(8);
  for (let i = 0; i < 8; i++) {
    let v = 0;
    for (let b = 0; b < 8; b++) v = (v << 1) | bits[i * 8 + b]!;
    out[i] = v;
  }
  return out;
}

/** テーブル（1 始まりの位置）に従ってビットを並べ替える */
function permute(src: Uint8Array, table: readonly number[]): Uint8Array {
  const out = new Uint8Array(table.length);
  for (let i = 0; i < table.length; i++) out[i] = src[table[i]! - 1]!;
  return out;
}

/** 28 ビットを左に n 回巡回シフト */
function rotl28(bits: Uint8Array, n: number): Uint8Array {
  const out = new Uint8Array(28);
  for (let i = 0; i < 28; i++) out[i] = bits[(i + n) % 28]!;
  return out;
}

/** 鍵（8 バイト）から 16 ラウンドのサブ鍵（各 48 ビット）を作る */
function keySchedule(key: Uint8Array): Uint8Array[] {
  const pc1 = permute(toBits(key), PC1); // 56 ビット
  let c = pc1.subarray(0, 28);
  let d = pc1.subarray(28, 56);
  const keys: Uint8Array[] = [];
  for (let round = 0; round < 16; round++) {
    c = rotl28(c, SHIFTS[round]!);
    d = rotl28(d, SHIFTS[round]!);
    const cd = new Uint8Array(56);
    cd.set(c, 0);
    cd.set(d, 28);
    keys.push(permute(cd, PC2)); // 48 ビット
  }
  return keys;
}

/** Feistel 関数 f(R, K) → 32 ビット */
function feistel(r: Uint8Array, k: Uint8Array): Uint8Array {
  const expanded = permute(r, E); // 48 ビット
  for (let i = 0; i < 48; i++) expanded[i] = expanded[i]! ^ k[i]!;
  const sOut = new Uint8Array(32);
  for (let box = 0; box < 8; box++) {
    const off = box * 6;
    const row = (expanded[off]! << 1) | expanded[off + 5]!;
    const col =
      (expanded[off + 1]! << 3) |
      (expanded[off + 2]! << 2) |
      (expanded[off + 3]! << 1) |
      expanded[off + 4]!;
    const val = S[box]![row * 16 + col]!;
    for (let b = 0; b < 4; b++) sOut[box * 4 + b] = (val >> (3 - b)) & 1;
  }
  return permute(sOut, P);
}

/**
 * DES で 8 バイトの平文を 1 ブロック暗号化する。
 * 鍵のパリティビット（各バイトの最下位ビット）は PC1 が落とすので無視される（標準どおり）。
 */
export function desEncryptBlock(key: Uint8Array, data: Uint8Array): Uint8Array {
  if (key.length !== 8 || data.length !== 8) {
    throw new Error(`DES block/key must be 8 bytes (key=${key.length}, data=${data.length})`);
  }
  const keys = keySchedule(key);
  const ip = permute(toBits(data), IP);
  let l = ip.subarray(0, 32);
  let r = ip.subarray(32, 64);
  for (let round = 0; round < 16; round++) {
    const f = feistel(r, keys[round]!);
    const nextR = new Uint8Array(32);
    for (let i = 0; i < 32; i++) nextR[i] = l[i]! ^ f[i]!;
    l = r;
    r = nextR;
  }
  // 最終は左右を入れ替えて結合（R16 ‖ L16）
  const preOutput = new Uint8Array(64);
  preOutput.set(r, 0);
  preOutput.set(l, 32);
  return fromBits(permute(preOutput, FP));
}
