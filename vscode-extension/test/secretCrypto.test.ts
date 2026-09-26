import { describe, it, expect } from "vitest";
import { ExtensionSecretCrypto } from "../src/secretCrypto.js";
import { mockSecretStorage as fakeSecretStorage } from "./vscode-mock.js";

describe("ExtensionSecretCrypto", () => {
  it("暗号化して復号すると元の平文に戻る", async () => {
    const crypto = await ExtensionSecretCrypto.fromSecretStorage(fakeSecretStorage());
    const enc = crypto.encrypt("hunter2");
    expect(enc.startsWith("v1:")).toBe(true);
    expect(crypto.decrypt(enc)).toBe("hunter2");
  });

  it("同じSecretStorageから2回作ると同じ鍵を再利用する（暗号文を相互に復号できる）", async () => {
    const secrets = fakeSecretStorage();
    const a = await ExtensionSecretCrypto.fromSecretStorage(secrets);
    const b = await ExtensionSecretCrypto.fromSecretStorage(secrets);
    expect(b.decrypt(a.encrypt("shared"))).toBe("shared");
  });

  it("異なるSecretStorage（＝異なる鍵）で暗号化したものは復号できない", async () => {
    const a = await ExtensionSecretCrypto.fromSecretStorage(fakeSecretStorage());
    const b = await ExtensionSecretCrypto.fromSecretStorage(fakeSecretStorage());
    expect(() => b.decrypt(a.encrypt("x"))).toThrow();
  });

  it("不正な形式の暗号文はthrowする", async () => {
    const crypto = await ExtensionSecretCrypto.fromSecretStorage(fakeSecretStorage());
    expect(() => crypto.decrypt("not-encrypted")).toThrow();
    expect(() => crypto.decrypt("v2:a:b:c")).toThrow();
  });

  it("改ざんされた暗号文（tagが合わない）はthrowする", async () => {
    const crypto = await ExtensionSecretCrypto.fromSecretStorage(fakeSecretStorage());
    const enc = crypto.encrypt("original");
    const parts = enc.split(":");
    // 平文部分（ct）を書き換える → GCMの認証タグ検証で弾かれるはず
    const tampered = `${parts[0]}:${parts[1]}:${parts[2]}:${Buffer.from("tampered!!").toString("base64")}`;
    expect(() => crypto.decrypt(tampered)).toThrow();
  });
});
