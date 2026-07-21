/**
 * パスワード置換値（password substitute）の生成。
 *
 * 平文パスワードは送らず、サーバー seed とクライアント seed を混ぜたハッシュを送る
 * （チャレンジ・レスポンス）。アルゴリズムはシステムのパスワードレベル（QPWDLVL）で分かれる。
 *
 * - レベル >= 2: SHA-1 を 2 回（`passwordSubstituteSha`）
 * - レベル 0/1: DES ベース（`passwordSubstituteDes`。IBM i の QPWDLVL 0/1 の実機で使う）
 *
 * 参照: JTOpen(jtopenlite) の EncryptPassword（encryptPasswordSHA / encryptPasswordDES）に対応する
 *       （コードの移植ではなく、アルゴリズム手順に基づく実装）。DES 経路は参照実装との
 *       差分テストでバイト単位に一致させて固定した（`hostserver-password.test.ts`）。
 */
import { As400Error } from "../errors.js";
import { desEncryptBlock } from "./des.js";

/** SHA 経路を使う最小パスワードレベル。これ未満は DES 経路 */
export const MIN_SHA_PASSWORD_LEVEL = 2;
/** seed の長さ */
export const SEED_LEN = 8;

/** ハッシュの最後に混ぜる固定のシーケンス番号（1） */
const SEQUENCE = Uint8Array.from([0, 0, 0, 0, 0, 0, 0, 1]);

/**
 * クライアント seed を作る。
 *
 * 本実装は暗号論的乱数を使う。参照実装は現在時刻ミリ秒を用いるが、チャレンジの seed が
 * 予測可能である必要はない（プロトコル上は任意の 8 バイト）。
 *
 * Node API ではなく Web Crypto の標準グローバルを使う（この層は Node 非依存に保つ）。
 */
export function generateClientSeed(): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(SEED_LEN));
}

/** SHA-1 ダイジェスト（Web Crypto。非同期なのは subtle.digest の仕様） */
async function sha1(...parts: Uint8Array[]): Promise<Uint8Array> {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const joined = new Uint8Array(total);
  let pos = 0;
  for (const part of parts) {
    joined.set(part, pos);
    pos += part.length;
  }
  return new Uint8Array(await crypto.subtle.digest("SHA-1", joined));
}

/**
 * SHA 経路のパスワード置換値を作る（20 バイト）。
 *
 * ```
 * token  = SHA1( userId ‖ password )
 * result = SHA1( token ‖ serverSeed ‖ clientSeed ‖ userId ‖ 0x0000000000000001 )
 * ```
 *
 * @param userIdUnicode UTF-16BE 20 バイト・空白詰め・大文字化（credentials.userIdUnicode）
 * @param passwordUtf16be UTF-16BE・詰めなし・大文字化しない（credentials.passwordUnicode）
 */
export async function passwordSubstituteSha(
  userIdUnicode: Uint8Array,
  passwordUtf16be: Uint8Array,
  clientSeed: Uint8Array,
  serverSeed: Uint8Array
): Promise<Uint8Array> {
  assertSeed(clientSeed, "client");
  assertSeed(serverSeed, "server");

  const token = await sha1(userIdUnicode, passwordUtf16be);
  return sha1(token, serverSeed, clientSeed, userIdUnicode, SEQUENCE);
}

/**
 * DES 経路（パスワードレベル 0/1）の置換値を作る（8 バイト）。
 *
 * レベル 0/1 のシステムは SHA ではなく DES ベースのチャレンジ・レスポンスを要求する。
 * アルゴリズムは jtopenlite `EncryptPassword.encryptPasswordDES`（generateToken →
 * generatePasswordSubstitute）に基づく（コードの移植ではなく、手順に基づく実装）。
 * 正しさは参照実装との差分テストで固定する（`password.test.ts`）。
 *
 * @param userIdEbcdic ユーザー ID（CCSID 37・10 バイト・0x40 詰め・大文字化）
 * @param passwordEbcdic パスワード（CCSID 37・10 バイト・0x40 詰め・大文字化。レベル 0/1 は大小無視）
 */
export function passwordSubstituteDes(
  userIdEbcdic: Uint8Array,
  passwordEbcdic: Uint8Array,
  clientSeed: Uint8Array,
  serverSeed: Uint8Array
): Uint8Array {
  assertSeed(clientSeed, "client");
  assertSeed(serverSeed, "server");
  if (userIdEbcdic.length !== 10 || passwordEbcdic.length !== 10) {
    throw new As400Error(
      "PROTOCOL_ERROR",
      `DES auth expects 10-byte EBCDIC user/password (got ${userIdEbcdic.length}/${passwordEbcdic.length})`
    );
  }
  const token = generateDesToken(userIdEbcdic, passwordEbcdic);
  const sequence = Uint8Array.from([0, 0, 0, 0, 0, 0, 0, 1]);

  // RDrSEQ = sequence + serverSeed（8 バイトの多倍長加算）
  const rdrSeq = addArray8(sequence, serverSeed);
  // enc1 = DES(token, RDrSEQ)
  let enc = desEncryptBlock(token, rdrSeq);
  // enc2 = DES(token, enc1 ^ clientSeed)
  enc = desEncryptBlock(token, xor8(enc, clientSeed));
  // 3 番目: DES(token, (userID[0..7] ^ RDrSEQ) ^ enc2)
  let data = xor8(xor8(userIdEbcdic.subarray(0, 8), rdrSeq), enc);
  enc = desEncryptBlock(token, data);
  // 4 番目: userID の後半 2 バイトを左詰め・0x40 埋め → RDrSEQ ^ それ ^ enc3
  const secondHalf = new Uint8Array(8).fill(0x40);
  secondHalf[0] = userIdEbcdic[8]!;
  secondHalf[1] = userIdEbcdic[9]!;
  data = xor8(xor8(rdrSeq, secondHalf), enc);
  enc = desEncryptBlock(token, data);
  // 5 番目（最終）: DES(token, sequence ^ enc4)
  return desEncryptBlock(token, xor8(sequence, enc));
}

/** DES トークン（8 バイト）を作る。userID/password は EBCDIC 10 バイト・0x40 詰め */
function generateDesToken(userIdEbcdic: Uint8Array, passwordEbcdic: Uint8Array): Uint8Array {
  const key = Uint8Array.from(userIdEbcdic); // 10 バイト。DES では先頭 8 バイトを使う
  // ユーザー ID が 8 文字超なら 9・10 文字目を先頭 8 バイトへ畳み込む
  if (ebcdicStrLen(userIdEbcdic) > 8) {
    key[0] = key[0]! ^ (key[8]! & 0xc0);
    key[1] = key[1]! ^ ((key[8]! & 0x30) << 2);
    key[2] = key[2]! ^ ((key[8]! & 0x0c) << 4);
    key[3] = key[3]! ^ ((key[8]! & 0x03) << 6);
    key[4] = key[4]! ^ (key[9]! & 0xc0);
    key[5] = key[5]! ^ ((key[9]! & 0x30) << 2);
    key[6] = key[6]! ^ ((key[9]! & 0x0c) << 4);
    key[7] = key[7]! ^ ((key[9]! & 0x03) << 6);
  }
  // **DES の鍵は「0x55 XOR & 左シフトしたパスワード」、データは畳んだ userID**
  // （参照の enc_des(key=shiftedPassword, data=userID)。ここを逆にすると全滅する）
  const userData = key.subarray(0, 8);

  const pwLen = ebcdicStrLen(passwordEbcdic);
  if (pwLen > 8) {
    // 前半 8 バイトと後半（9・10 文字目）を別々に DES し、XOR してトークンにする
    const buf1 = new Uint8Array(8).fill(0x40);
    buf1.set(passwordEbcdic.subarray(0, 8));
    const buf2 = new Uint8Array(8).fill(0x40);
    buf2.set(passwordEbcdic.subarray(8, pwLen));
    const t1 = desEncryptBlock(xorWith0x55AndLshift(buf1), userData);
    const t2 = desEncryptBlock(xorWith0x55AndLshift(buf2), userData);
    return xor8(t1, t2);
  }
  const buf = new Uint8Array(8).fill(0x40);
  buf.set(passwordEbcdic.subarray(0, pwLen));
  return desEncryptBlock(xorWith0x55AndLshift(buf), userData);
}

/** EBCDIC 文字列の長さ（0x40 または 0x00 の手前まで、最大 10） */
function ebcdicStrLen(s: Uint8Array): number {
  let i = 0;
  while (i < 10 && s[i] !== 0x40 && s[i] !== 0x00) i++;
  return i;
}

/** 各バイトを 0x55 と XOR したのち、全体を 1 ビット左シフトする（8 バイト） */
function xorWith0x55AndLshift(input: Uint8Array): Uint8Array {
  const b = new Uint8Array(8);
  for (let i = 0; i < 8; i++) b[i] = input[i]! ^ 0x55;
  const out = new Uint8Array(8);
  for (let i = 0; i < 7; i++) out[i] = ((b[i]! << 1) | ((b[i + 1]! & 0x80) >>> 7)) & 0xff;
  out[7] = (b[7]! << 1) & 0xff;
  return out;
}

/** 8 バイトの多倍長加算（キャリー付き。上位あふれは捨てる） */
function addArray8(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(8);
  let carry = 0;
  for (let i = 7; i >= 0; i--) {
    const t = a[i]! + b[i]! + carry;
    carry = t >>> 8;
    out[i] = t & 0xff;
  }
  return out;
}

/** 8 バイトの XOR */
function xor8(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(8);
  for (let i = 0; i < 8; i++) out[i] = a[i]! ^ b[i]!;
  return out;
}

function assertSeed(seed: Uint8Array, which: string): void {
  if (seed.length !== SEED_LEN) {
    throw new As400Error(
      "PROTOCOL_ERROR",
      `${which} seed must be ${SEED_LEN} bytes, got ${seed.length}`
    );
  }
}
