import { describe, it, expect } from "vitest";
import {
  userIdEbcdic37,
  userIdUnicode,
  passwordUnicode,
  decodeJobName,
  MAX_USER_LEN
} from "../src/credentials.js";
import { As400Error } from "@ts5250/base";

const hex = (b: Uint8Array): string => Buffer.from(b).toString("hex");

/**
 * 同じユーザー ID が用途で 3 通りに符号化される。取り違えると認証が通らないため、
 * それぞれの形式をバイト列で固定する。
 */
describe("userIdEbcdic37（要求 CP 0x1104 用）", () => {
  it("CCSID 37 の 10 バイトに 0x40 詰めする", () => {
    // USER → E4 E2 C5 D9、残り 6 バイトは EBCDIC 空白 0x40
    expect(hex(userIdEbcdic37("USER"))).toBe("e4e2c5d9" + "40".repeat(6));
  });

  it("小文字を大文字化する", () => {
    expect(userIdEbcdic37("user")).toEqual(userIdEbcdic37("USER"));
  });

  it("10 文字ちょうどは通る", () => {
    expect(userIdEbcdic37("ABCDEFGHIJ")).toHaveLength(MAX_USER_LEN);
  });

  it("システム CCSID 273 ではなく 37 を使う（'@' が両者で異なることで示す）", () => {
    // CCSID 37 で '@' は 0x7C。273 では 0xB5 なので、37 が使われていることが分かる
    expect(hex(userIdEbcdic37("@")).slice(0, 2)).toBe("7c");
  });

  it("11 文字以上を拒否する", () => {
    expect(() => userIdEbcdic37("ABCDEFGHIJK")).toThrow(As400Error);
    expect(() => userIdEbcdic37("ABCDEFGHIJK")).toThrow(/too long/);
  });

  it("空を拒否する", () => {
    expect(() => userIdEbcdic37("")).toThrow(/empty/);
  });

  it("CCSID 37 で表せない文字を拒否する（黙って 0x3F を送らない）", () => {
    expect(() => userIdEbcdic37("日本語")).toThrow(/not representable/);
  });
});

describe("userIdUnicode（ハッシュ入力用）", () => {
  it("UTF-16BE 20 バイトに空白詰めする", () => {
    const b = userIdUnicode("USER");
    expect(b).toHaveLength(20);
    // U=0x0055 S=0x0053 E=0x0045 R=0x0052、残り 6 文字は UTF-16BE の空白 0x0020
    expect(hex(b)).toBe("0055005300450052" + "0020".repeat(6));
  });

  it("大文字化する", () => {
    expect(userIdUnicode("user")).toEqual(userIdUnicode("USER"));
  });

  it("長さ・空の検査は EBCDIC 版と同じ", () => {
    expect(() => userIdUnicode("ABCDEFGHIJK")).toThrow(/too long/);
    expect(() => userIdUnicode("")).toThrow(/empty/);
  });
});

describe("passwordUnicode（ハッシュ入力用）", () => {
  it("UTF-16BE にする（詰めなし）", () => {
    expect(hex(passwordUnicode("ab"))).toBe("00610062");
    expect(passwordUnicode("abc")).toHaveLength(6);
  });

  it("大文字化しない（レベル 2 以上は大小を区別する）", () => {
    expect(passwordUnicode("abc")).not.toEqual(passwordUnicode("ABC"));
  });

  it("10 文字を超えても通る（パスフレーズ）", () => {
    expect(passwordUnicode("a".repeat(40))).toHaveLength(80);
  });

  it("空を拒否する", () => {
    expect(() => passwordUnicode("")).toThrow(/empty/);
  });
});

/**
 * ジョブ名（CP 0x111f）。
 *
 * **障害切り分けで実機のジョブと突き合わせる**ために画面まで通しているので、
 * 実機が返した形をバイト列で固定する。
 */
describe("decodeJobName", () => {
  /** 実機（PUB400・database サーバー）が 0xf002 で返した値そのもの */
  const REAL = "00000000f8f3f6f9f9f561d8e4e2c5d961d8e9c4c1e2e2c9d5c9e3";

  it("実機の応答から `836995/QUSER/QZDASSINIT` を読む", () => {
    expect(decodeJobName(Buffer.from(REAL, "hex"))).toBe("836995/QUSER/QZDASSINIT");
  });

  it("末尾の空白を落とす", () => {
    // 先頭 4 バイトの前置き + "AB" + EBCDIC 空白 2 つ
    const v = Buffer.from("00000000" + "c1c2" + "4040", "hex");
    expect(decodeJobName(v)).toBe("AB");
  });

  it("**無い・短い・空なら undefined**（接続自体は成立しているので落とさない）", () => {
    expect(decodeJobName(undefined)).toBeUndefined();
    expect(decodeJobName(Buffer.from("000000", "hex"))).toBeUndefined();
    expect(decodeJobName(Buffer.from("00000000", "hex"))).toBeUndefined();
    expect(decodeJobName(Buffer.from("00000000" + "4040", "hex"))).toBeUndefined();
  });
});
