import { describe, it, expect } from "vitest";
import {
  passwordSubstituteSha,
  assertPasswordLevelSupported,
  generateClientSeed,
  SEED_LEN
} from "../src/hostserver/password.js";
import { userIdUnicode, passwordUnicode } from "../src/hostserver/credentials.js";
import { Tn5250Error } from "../src/errors.js";

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

describe("assertPasswordLevelSupported", () => {
  it("レベル 2 以上は通す", () => {
    expect(() => assertPasswordLevelSupported(2)).not.toThrow();
    expect(() => assertPasswordLevelSupported(3)).not.toThrow();
  });

  it("レベル 0/1（DES 経路）は未対応として明示的に失敗する", () => {
    for (const level of [0, 1]) {
      expect(() => assertPasswordLevelSupported(level)).toThrow(Tn5250Error);
      expect(() => assertPasswordLevelSupported(level)).toThrow(/not implemented/);
    }
  });

  it("未対応は専用のエラーコードで返す（認証失敗と混同させない）", () => {
    try {
      assertPasswordLevelSupported(0);
      expect.unreachable();
    } catch (e) {
      expect((e as Tn5250Error).code).toBe("HOST_SERVER_UNSUPPORTED");
    }
  });
});
