import { describe, it, expect } from "vitest";
import { randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SecretCrypto } from "../src/secret-crypto.js";

const KEY_HEX = randomBytes(32).toString("hex");

describe("SecretCrypto", () => {
  it("暗号化→復号で元の平文に戻る", () => {
    const sc = SecretCrypto.fromEnv("K", { K: KEY_HEX })!;
    expect(sc).toBeDefined();
    const blob = sc.encrypt("s3cret-pw@USER");
    expect(blob).toMatch(/^v1:/);
    expect(blob).not.toContain("s3cret");
    expect(sc.decrypt(blob)).toBe("s3cret-pw@USER");
  });

  it("同じ平文でも IV により暗号文は毎回変わる", () => {
    const sc = SecretCrypto.fromEnv("K", { K: KEY_HEX })!;
    expect(sc.encrypt("x")).not.toBe(sc.encrypt("x"));
  });

  it("改ざん（tag 不正）は復号で throw する", () => {
    const sc = SecretCrypto.fromEnv("K", { K: KEY_HEX })!;
    const blob = sc.encrypt("hello");
    const parts = blob.split(":");
    const badTag = Buffer.from(parts[2]!, "base64");
    badTag[0] = badTag[0]! ^ 0xff;
    const tampered = [parts[0], parts[1], badTag.toString("base64"), parts[3]].join(":");
    expect(() => sc.decrypt(tampered)).toThrow();
  });

  it("別の鍵では復号できない", () => {
    const a = SecretCrypto.fromEnv("K", { K: KEY_HEX })!;
    const b = SecretCrypto.fromEnv("K", { K: randomBytes(32).toString("hex") })!;
    expect(() => b.decrypt(a.encrypt("hello"))).toThrow();
  });

  it("base64 鍵も受理する", () => {
    const b64 = randomBytes(32).toString("base64");
    const sc = SecretCrypto.fromEnv("K", { K: b64 })!;
    expect(sc.decrypt(sc.encrypt("z"))).toBe("z");
  });

  it("鍵未設定なら undefined を返す", () => {
    expect(SecretCrypto.fromEnv("K", {})).toBeUndefined();
    expect(SecretCrypto.fromEnv("K", { K: "" })).toBeUndefined();
  });

  it("鍵長が不正なら throw する", () => {
    expect(() => SecretCrypto.fromEnv("K", { K: "tooshort" })).toThrow(/32-byte|must/);
    expect(() => SecretCrypto.fromEnv("K", { K: "ab".repeat(20) })).toThrow();
  });

  it("未対応フォーマットの blob は throw する", () => {
    const sc = SecretCrypto.fromEnv("K", { K: KEY_HEX })!;
    expect(() => sc.decrypt("v2:a:b:c")).toThrow(/format/);
    expect(() => sc.decrypt("garbage")).toThrow();
  });
});

describe("SecretCrypto.fromEnvOrCreate（単一利用者向け自動生成）", () => {
  function tmpEnv(): string {
    return join(mkdtempSync(join(tmpdir(), "key-")), ".env");
  }

  it("env に鍵があればそれを使い、生成しない", () => {
    const r = SecretCrypto.fromEnvOrCreate("K", tmpEnv(), { K: KEY_HEX });
    expect(r.generated).toBe(false);
    expect(r.crypto.decrypt(r.crypto.encrypt("x"))).toBe("x");
  });

  it("env に無ければ生成して keyFile に保存し process.env にも載せる", () => {
    const path = tmpEnv();
    const env: NodeJS.ProcessEnv = {};
    const r = SecretCrypto.fromEnvOrCreate("K", path, env);
    expect(r.generated).toBe(true);
    // keyFile に書かれ、env にも載る
    expect(readFileSync(path, "utf8")).toMatch(/^K=[0-9a-f]{64}$/m);
    expect(env["K"]).toMatch(/^[0-9a-f]{64}$/);
    // 生成した鍵で暗復号できる
    expect(r.crypto.decrypt(r.crypto.encrypt("hi"))).toBe("hi");
  });

  it("既存 keyFile の鍵を再利用し、重複生成しない", () => {
    const path = tmpEnv();
    writeFileSync(path, `FOO=bar\nK=${KEY_HEX}\n`);
    const env: NodeJS.ProcessEnv = {};
    const r = SecretCrypto.fromEnvOrCreate("K", path, env);
    expect(r.generated).toBe(false);
    expect(env["K"]).toBe(KEY_HEX);
    // ファイルは追記されていない（K は 1 回だけ）
    expect((readFileSync(path, "utf8").match(/^K=/gm) ?? []).length).toBe(1);
  });

  it("既存ファイルへ追記しても他の変数を壊さない", () => {
    const path = tmpEnv();
    writeFileSync(path, "PUB400_PASSWORD=secret\n");
    SecretCrypto.fromEnvOrCreate("K", path, {});
    const content = readFileSync(path, "utf8");
    expect(content).toContain("PUB400_PASSWORD=secret");
    expect(content).toMatch(/^K=[0-9a-f]{64}$/m);
  });
});
