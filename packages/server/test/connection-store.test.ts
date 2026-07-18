import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { ConnectionStore } from "../src/connection-store.js";
import { SecretCrypto } from "../src/secret-crypto.js";
import type { AuthUser } from "../src/auth.js";

const crypto = SecretCrypto.fromEnv("K", { K: randomBytes(32).toString("hex") })!;
const alice: AuthUser = { username: "alice", role: "user" };
const bob: AuthUser = { username: "bob", role: "user" };
const admin: AuthUser = { username: "root", role: "admin" };

function baseInput(over: Record<string, unknown> = {}): unknown {
  return { name: "pub400", host: "pub400.com", sessionType: "display", ...over };
}

describe("ConnectionStore: 認可と owner 分離", () => {
  let store: ConnectionStore;
  beforeEach(() => {
    store = new ConnectionStore([], crypto);
  });

  it("認証オンでは作成時に owner=username が入り、一覧は自分の分のみ", () => {
    store.add(baseInput({ name: "a1" }), alice);
    store.add(baseInput({ name: "b1" }), bob);
    expect(store.listForUser(alice).map((c) => c.name)).toEqual(["a1"]);
    expect(store.listForUser(bob).map((c) => c.name)).toEqual(["b1"]);
  });

  it("admin は全件、無主レコードも見える", () => {
    store.add(baseInput({ name: "a1" }), alice);
    store.add(baseInput({ name: "noone" }), undefined); // 無主
    expect(store.listForUser(admin).map((c) => c.name).sort()).toEqual(["a1", "noone"]);
  });

  it("一般ユーザーには無主レコードは出ない", () => {
    store.add(baseInput({ name: "noone" }), undefined);
    expect(store.listForUser(alice)).toEqual([]);
  });

  it("認証オフ（user=undefined）は全件見える", () => {
    store.add(baseInput({ name: "a1" }), alice);
    store.add(baseInput({ name: "noone" }), undefined);
    expect(store.listForUser(undefined).map((c) => c.name).sort()).toEqual(["a1", "noone"]);
  });

  it("他人の接続を更新・削除・解決すると FORBIDDEN", () => {
    const c = store.add(baseInput(), alice);
    expect(() => store.update(c.id, baseInput(), bob)).toThrow(/forbidden/i);
    expect(() => store.remove(c.id, bob)).toThrow(/forbidden/i);
    expect(() => store.resolveConnectOptions(c.id, bob)).toThrow(/forbidden/i);
  });

  it("存在しない id は SESSION_NOT_FOUND(404 相当)", () => {
    expect(() => store.get("nope")).toThrow(/not found/i);
  });
});

describe("ConnectionStore: 信頼境界（strict）", () => {
  it("printer 出力系フィールドを含む入力は拒否する", () => {
    const store = new ConnectionStore([], crypto);
    expect(() => store.add(baseInput({ autoPdfDir: "/etc" }), admin)).toThrow();
    expect(() => store.add(baseInput({ autoPrint: "PRT1" }), admin)).toThrow();
    expect(() => store.add(baseInput({ pdfFontPath: "/x" }), admin)).toThrow();
  });

  it("PublicConnection は secretEnc を含まず hasSecret のみ返す", () => {
    const store = new ConnectionStore([], crypto);
    const c = store.add(baseInput({ autoSignon: true, signonUser: "u", password: "p" }), alice);
    expect(c.hasSecret).toBe(true);
    expect(c as Record<string, unknown>).not.toHaveProperty("secretEnc");
    expect(c as Record<string, unknown>).not.toHaveProperty("password");
  });
});

describe("ConnectionStore: パスワード暗号化と解決", () => {
  let store: ConnectionStore;
  beforeEach(() => {
    store = new ConnectionStore([], crypto);
  });

  it("password は暗号化されて resolve で復号される", () => {
    const c = store.add(baseInput({ autoSignon: true, signonUser: "USER", password: "pw@1" }), alice);
    const opts = store.resolveConnectOptions(c.id, alice);
    expect(opts.user).toBe("USER");
    expect(opts.password).toBe("pw@1");
  });

  it("update: password 未指定は据え置き、空文字は解除、非空は再暗号化", () => {
    const c = store.add(baseInput({ autoSignon: true, signonUser: "USER", password: "old" }), alice);
    // 未指定 → 据え置き
    store.update(c.id, baseInput({ autoSignon: true, signonUser: "USER" }), alice);
    expect(store.resolveConnectOptions(c.id, alice).password).toBe("old");
    // 非空 → 再暗号化
    store.update(c.id, baseInput({ autoSignon: true, signonUser: "USER", password: "new" }), alice);
    expect(store.resolveConnectOptions(c.id, alice).password).toBe("new");
    // 空文字 → 解除
    const pub = store.update(c.id, baseInput({ autoSignon: true, signonUser: "USER", password: "" }), alice);
    expect(pub.hasSecret).toBe(false);
    expect(store.resolveConnectOptions(c.id, alice).password).toBeUndefined();
  });

  it("鍵未設定のストアで password を保存しようとすると CONFIG_ERROR", () => {
    const noKey = new ConnectionStore([], undefined);
    expect(() => noKey.add(baseInput({ autoSignon: true, signonUser: "u", password: "p" }), alice)).toThrow(
      /secret key not configured/i
    );
  });

  it("復号できない secretEnc は password 無しで続行（warn）", () => {
    const other = SecretCrypto.fromEnv("K", { K: randomBytes(32).toString("hex") })!;
    const c = store.add(baseInput({ autoSignon: true, signonUser: "u", password: "p" }), alice);
    // 別の鍵のストアで同じレコードを解決 → 復号失敗
    const rec = JSON.parse(
      JSON.stringify({ connections: [{ ...(store as unknown as { byId: Map<string, unknown> }).byId.get(c.id) }] })
    );
    const store2 = new ConnectionStore(rec.connections, other);
    let warned = "";
    const opts = store2.resolveConnectOptions(c.id, alice, (m) => (warned = m));
    expect(opts.password).toBeUndefined();
    expect(opts.host).toBe("pub400.com");
    expect(warned).toMatch(/decrypt/i);
  });
});

describe("ConnectionStore: 永続化", () => {
  it("fromFile 未作成は空で開始し、save で atomic 書き込みできる", async () => {
    const dir = mkdtempSync(join(tmpdir(), "conn-"));
    const path = join(dir, "connections.json");
    const store = ConnectionStore.fromFile(path, crypto);
    expect(store.size).toBe(0);
    store.add(baseInput({ name: "saved" }), alice);
    await store.save();
    const onDisk = JSON.parse(readFileSync(path, "utf8"));
    expect(onDisk.connections).toHaveLength(1);
    expect(onDisk.connections[0].name).toBe("saved");
    // 再読込で復元
    const reloaded = ConnectionStore.fromFile(path, crypto);
    expect(reloaded.listForUser(alice).map((c) => c.name)).toEqual(["saved"]);
  });
});
