import { describe, it, expect } from "vitest";
import { bypassSignonSubstitute } from "../src/bypass-signon.js";

/**
 * **自動サインオンの代替パスワードは ACS と同じバイト列**（`20260921-encrypted-autosignon`）。
 *
 * 期待値は ACS の `PasswordSubstitute.getPasswordSubstitute` を Java から直接呼んだ出力（利用者名・パスワード・シードは合成）。
 * 実物の資格情報は使っていない。シードは `seed(base)[i] = base + i*17`（クライアント 0x11・サーバー 0xa3）。
 */
const seed = (base: number) => Uint8Array.from({ length: 8 }, (_, i) => (base + i * 17) & 0xff);
const hex = (b: Uint8Array) => [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
const sub = async (level: number, user: string, pw: string) =>
  hex(await bypassSignonSubstitute(level, user, pw, seed(0x11), seed(0xa3)));

describe("QPWDLVL 0 / 1（DES）", () => {
  it("ACS の出力と一致する", async () => {
    for (const level of [0, 1]) {
      expect(await sub(level, "TESTUSR", "secret1")).toBe("bc647336c8c1b7c1");
      expect(await sub(level, "USER10CHAR", "Pa55w0rd")).toBe("b6a7f026ed9fc5b6");
    }
  });
  it("**数字で始まるパスワードは頭に Q**（`1234` → `Q1234`）", async () => {
    expect(await sub(0, "U1", "1234")).toBe("9a39dde3a84b0881");
  });
  it("10 文字を超える・表に無い文字（空白）はエラー（ACS も例外）", async () => {
    await expect(sub(0, "ABC", "longerPassWord123")).rejects.toThrow();
    await expect(sub(0, "X", "a b  ")).rejects.toThrow();
  });
});

describe("QPWDLVL 2 / 3（SHA-1）", () => {
  it("ACS の出力と一致する（大文字にしない・末尾の空白を落とす）", async () => {
    for (const level of [2, 3]) {
      expect(await sub(level, "TESTUSR", "secret1")).toBe("f0a91780745d803d674ef25056e9f5b551f50077");
      expect(await sub(level, "USER10CHAR", "Pa55w0rd")).toBe("c78d2f61fa327180eea7c52a59d5c54dc0d90458");
      expect(await sub(level, "U1", "1234")).toBe("f99295aa9015d65e4a3ecaabcb045255d18464cf");
      expect(await sub(level, "ABC", "longerPassWord123")).toBe("726e8e809752bca0e9ffc3c6f89ffc81ba85799c");
      expect(await sub(level, "X", "a b  ")).toBe("bda3cc5f36893a15292f684ed5a42175bd2121d7");
    }
  });
  it("`*` で始まるパスワードはエラー（ACS も例外）", async () => {
    await expect(sub(3, "X", "*abc")).rejects.toThrow();
  });
});

describe("QPWDLVL 4（PBKDF2-HMAC-SHA512・SHA-512）", () => {
  it("ACS の出力と一致する", async () => {
    expect(await sub(4, "TESTUSR", "secret1")).toBe(
      "45097c20928339589618226e983bfdafb96ef7c54c854b9ec31984a2624923bd764c55b50cee7649b89423466ad1e0244a8963b7631089285f570a1063cd9883"
    );
    expect(await sub(4, "U1", "1234")).toBe(
      "6d16e2586e2a1d5d5bec41b6041f355c4184a471319145177d935dde6df000f2c10b3a8b2771f8233c4a18b18ed7536a998e4f87623844be18dc21fb402a9673"
    );
    expect(await sub(4, "X", "a b  ")).toBe(
      "e54ef5417ec7beb525b1db8013c76e06dae48ec0ca3a1811cd60d6c3695f5007bd2dd4a639c510622596191871514780fcac10b7d35d703501f7d22f9cb38feb"
    );
  });
});
