/**
 * **telnet の自動サインオン（バイパス・サインオン）の代替パスワード**（`20260921-encrypted-autosignon`）。
 *
 * ACS は自動サインオンでパスワードを平文で送らない。ホストが NEW-ENVIRON SEND で渡すサーバーのシード（`IBMRSEED` の後ろの
 * 8 バイト）と自分のシードから代替パスワードを作り、`IBMRSEED` に自分のシード、`IBMSUBSPW` に代替パスワードを入れる
 * （`NVT5250.insertVariable`・`PasswordSubstitute.getPasswordSubstitute`）。計算は QPWDLVL で分かれる:
 * - 0 / 1 … DES（8 バイト）。パスワードは大文字にし、**数字で始まれば頭に `Q`**。10 文字まで。使える文字は下の表だけ
 * - 2 / 3 … SHA-1（20 バイト）。パスワードは大文字にせず、末尾の空白（U+0000・U+0020・U+3000）を落とす。`*` で始まるものは不可
 * - 4 …… PBKDF2-HMAC-SHA512（10022 回）で鍵を作り、SHA-512（64 バイト）
 * 手順は ACS の原典から書き起こし、ACS の `PasswordSubstitute` を Java から呼んだ出力とバイト単位で突き合わせて固定した
 * （`bypass-signon.test.ts`）。DES・SHA-1 の本体はホストサーバーのサインオンと共用する（`password.ts`）。
 */
import { As400Error } from "@ts5250/base";
import { passwordSubstituteDes, passwordSubstituteSha, passwordSubstituteSha512, MIN_SHA512_PASSWORD_LEVEL, SEED_LEN } from "./password.js";

/** ACS `SignonConverter.stringToByteArray` の表（CCSID 37。各国の置き換え文字は # $ @ に寄る）。これ以外の文字はエラー */
const SIGNON_EBCDIC: Readonly<Record<string, number>> = (() => {
  const t: Record<string, number> = { "#": 0x7b, $: 0x5b, "@": 0x7c, _: 0x6d };
  for (let i = 0; i < 10; i++) t[String(i)] = 0xf0 + i;
  const rows: [string, number][] = [["ABCDEFGHI", 0xc1], ["JKLMNOPQR", 0xd1], ["STUVWXYZ", 0xe2]];
  for (const [letters, start] of rows) [...letters].forEach((c, i) => (t[c] = start + i));
  for (const c of "\u00a3\u00c4\u00c6\u00d1") t[c] = 0x7b;
  for (const c of "\u00a5\u00c5\u0130") t[c] = 0x5b;
  for (const c of "\u00a7\u00d0\u00d6\u00d8\u00e0\u015e") t[c] = 0x7c;
  return t;
})();
/** 表の逆（EBCDIC → 文字）。SHA の経路は、いったん EBCDIC にした利用者名を文字へ戻して UTF-16 にする */
const SIGNON_CHAR: Readonly<Record<number, string>> = { 0x7b: "#", 0x5b: "$", 0x7c: "@", 0x6d: "_", 0x40: " " };

/** 10 バイト・0x40 詰めの EBCDIC（表に無い文字はエラー） */
function signonEbcdic(s: string): Uint8Array {
  if (s.length > 10) throw new As400Error("CONFIG_ERROR", "user or password longer than 10 characters for this password level");
  const out = new Uint8Array(10).fill(0x40);
  [...s].forEach((c, i) => {
    const b = SIGNON_EBCDIC[c];
    if (b === undefined) throw new As400Error("CONFIG_ERROR", `character not allowed in user or password (position ${i + 1})`);
    out[i] = b;
  });
  return out;
}

function ebcdicToChars(b: Uint8Array): string {
  return [...b]
    .map((x) => {
      if (SIGNON_CHAR[x] !== undefined) return SIGNON_CHAR[x];
      if (x >= 0xf0 && x <= 0xf9) return String(x - 0xf0);
      if (x >= 0xc1 && x <= 0xc9) return String.fromCharCode(65 + x - 0xc1);
      if (x >= 0xd1 && x <= 0xd9) return String.fromCharCode(74 + x - 0xd1);
      return String.fromCharCode(83 + x - 0xe2);
    })
    .join("");
}

function utf16be(s: string): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(s.length * 2);
  for (let i = 0; i < s.length; i++) {
    out[i * 2] = s.charCodeAt(i) >> 8;
    out[i * 2 + 1] = s.charCodeAt(i) & 0xff;
  }
  return out;
}


/**
 * 自動サインオンの代替パスワードを作る。`user` は大文字・前後の空白を落とした利用者名（telnet の USER と同じもの）。
 * `clientSeed` は `IBMRSEED` に入れる自分のシード、`serverSeed` はホストの SEND の `IBMRSEED` の後ろの 8 バイト。
 */
export async function bypassSignonSubstitute(
  passwordLevel: number,
  user: string,
  password: string,
  clientSeed: Uint8Array,
  serverSeed: Uint8Array
): Promise<Uint8Array> {
  if (clientSeed.length !== SEED_LEN || serverSeed.length !== SEED_LEN) {
    throw new As400Error("PROTOCOL_ERROR", `seeds must be ${SEED_LEN} bytes`);
  }
  // レベル 4 はホストサーバーのサインオンと同じ手順（`password.ts`。手順を 2 か所に書かない）
  if (passwordLevel >= MIN_SHA512_PASSWORD_LEVEL) return passwordSubstituteSha512(user, password, clientSeed, serverSeed);
  const userEbcdic = signonEbcdic(user);
  if (passwordLevel >= 2) {
    if (password.startsWith("*")) throw new As400Error("CONFIG_ERROR", "password must not start with '*'");
    const trimmed = password.replace(/[\u0000 \u3000]+$/, "");
    return passwordSubstituteSha(utf16be(ebcdicToChars(userEbcdic)), utf16be(trimmed), clientSeed, serverSeed);
  }
  // 0 / 1: 数字で始まるパスワードは頭に Q（ACS `normalizeNumericPassword`）
  const pw = /^[0-9]/.test(password) ? `Q${password}` : password;
  if (pw.length > 10) throw new As400Error("CONFIG_ERROR", "password longer than 10 characters for password level 0/1");
  return passwordSubstituteDes(userEbcdic, signonEbcdic(pw.toUpperCase()), clientSeed, serverSeed);
}
