import { describe, it, expect } from "vitest";
import {
  passwordSubstituteSha,
  passwordSubstituteDes,
  generateClientSeed,
  SEED_LEN
} from "../src/hostserver/password.js";
import {
  userIdUnicode,
  passwordUnicode,
  userIdEbcdic37,
  passwordEbcdic37
} from "../src/hostserver/credentials.js";

/**
 * 固定ベクタは**架空の資格情報**から算出したもの（実パスワードをテストに焼き付けない）。
 * アルゴリズムが仕様どおりかは実機での認証成功で担保し、ここは回帰検出に徹する。
 */
const USER = "TESTUSER";
const PASSWORD = "testpw";
const CLIENT_SEED = Uint8Array.from(Buffer.from("0102030405060708", "hex"));
const SERVER_SEED = Uint8Array.from(Buffer.from("a1b2c3d4e5f60718", "hex"));
const EXPECTED = "5d3c6b10b739fc90fde5cde0751685f912078d56";

const hex = (b: Uint8Array): string => Buffer.from(b).toString("hex");
const substitute = (user = USER, password = PASSWORD): Promise<Uint8Array> =>
  passwordSubstituteSha(userIdUnicode(user), passwordUnicode(password), CLIENT_SEED, SERVER_SEED);

describe("passwordSubstituteSha", () => {
  it("固定ベクタと一致する", async () => {
    expect(hex(await substitute())).toBe(EXPECTED);
  });

  it("20 バイト（SHA-1 の出力長）を返す", async () => {
    expect(await substitute()).toHaveLength(20);
  });

  it("パスワードの大小文字を区別する", async () => {
    expect(hex(await substitute(USER, "TESTPW"))).not.toBe(EXPECTED);
  });

  it("ユーザー ID の大小文字は区別しない（大文字化されるため）", async () => {
    expect(hex(await substitute("testuser"))).toBe(EXPECTED);
  });

  it("seed が変われば結果が変わる（リプレイ不可）", async () => {
    const other = await passwordSubstituteSha(
      userIdUnicode(USER),
      passwordUnicode(PASSWORD),
      CLIENT_SEED,
      Uint8Array.from(Buffer.from("0000000000000000", "hex"))
    );
    expect(hex(other)).not.toBe(EXPECTED);
  });

  it("client seed と server seed の順序を取り違えない", async () => {
    const swapped = await passwordSubstituteSha(
      userIdUnicode(USER),
      passwordUnicode(PASSWORD),
      SERVER_SEED,
      CLIENT_SEED
    );
    expect(hex(swapped)).not.toBe(EXPECTED);
  });

  it("平文パスワードが出力に現れない", async () => {
    expect(hex(await substitute())).not.toContain(Buffer.from(PASSWORD, "ascii").toString("hex"));
  });

  it("seed の長さが 8 でなければ拒否する", async () => {
    const uid = userIdUnicode(USER);
    const pw = passwordUnicode(PASSWORD);
    await expect(passwordSubstituteSha(uid, pw, new Uint8Array(7), SERVER_SEED)).rejects.toThrow(
      /client seed must be 8 bytes/
    );
    await expect(passwordSubstituteSha(uid, pw, CLIENT_SEED, new Uint8Array(9))).rejects.toThrow(
      /server seed must be 8 bytes/
    );
  });
});

describe("generateClientSeed", () => {
  it("8 バイトを返す", () => {
    expect(generateClientSeed()).toHaveLength(SEED_LEN);
  });

  it("呼ぶたびに異なる（時刻由来の予測可能な値を使わない）", () => {
    const seeds = new Set(Array.from({ length: 16 }, () => hex(generateClientSeed())));
    expect(seeds.size).toBe(16);
  });
});

describe("passwordSubstituteDes（パスワードレベル 0/1）", () => {
  // **参照実装（jtopenlite EncryptPassword.encryptPasswordDES）と差分テストで一致させた固定ベクタ**。
  // 架空の資格情報＋固定 seed で算出。CI に Java を要求しないよう値を焼き付ける。
  // パスワード長 6/10/1/9（8 文字境界をまたぐ）と、短い/10 文字の userID を網羅する。
  const CS = Uint8Array.from(Buffer.from("0102030405060708", "hex"));
  const SS = Uint8Array.from(Buffer.from("a1b2c3d4e5f60718", "hex"));
  const VECTORS: [user: string, password: string, expected: string][] = [
    ["TESTUSER", "testpw", "252131427253cb8d"],
    ["MYLONGUSER", "Secret1234", "8341a64ce35fef72"],
    ["AB", "X", "32bfd6fdf82ece5f"],
    ["QUSER", "abcdefghi", "551d52228a863259"]
  ];
  const des = (user: string, password: string, cs = CS, ss = SS): Uint8Array =>
    passwordSubstituteDes(userIdEbcdic37(user), passwordEbcdic37(password), cs, ss);

  it("参照実装の固定ベクタと一致する（DES + 合成の end-to-end）", () => {
    for (const [user, password, expected] of VECTORS) {
      expect(hex(des(user, password))).toBe(expected);
    }
  });

  it("8 バイト（DES 1 ブロック）を返す", () => {
    expect(des("TESTUSER", "testpw")).toHaveLength(8);
  });

  it("パスワードの大小文字を区別しない（レベル 0/1 は大文字化）", () => {
    expect(hex(des("TESTUSER", "TESTPW"))).toBe(hex(des("TESTUSER", "testpw")));
  });

  it("ユーザー ID の大小文字も区別しない", () => {
    expect(hex(des("testuser", "testpw"))).toBe(VECTORS[0]![2]);
  });

  it("seed が変われば結果が変わる（リプレイ不可）", () => {
    const other = des("TESTUSER", "testpw", CS, Uint8Array.from(Buffer.from("0000000000000000", "hex")));
    expect(hex(other)).not.toBe(VECTORS[0]![2]);
  });

  it("client/server seed を取り違えない", () => {
    expect(hex(des("TESTUSER", "testpw", SS, CS))).not.toBe(VECTORS[0]![2]);
  });

  it("10 文字を超えるパスワードは弾く（DES 経路の上限）", () => {
    expect(() => des("TESTUSER", "12345678901")).toThrow(/password too long/);
  });

  it("seed の長さが 8 でなければ拒否する", () => {
    expect(() => passwordSubstituteDes(userIdEbcdic37("A"), passwordEbcdic37("B"), new Uint8Array(7), SS)).toThrow(
      /client seed must be 8 bytes/
    );
  });
});
