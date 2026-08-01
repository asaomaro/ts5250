import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { ServerConfigStore, PersonalConfigStore } from "../src/config-store.js";
import { SecretCrypto } from "../src/secret-crypto.js";
import type { AuthUser } from "../src/auth.js";

/**
 * **サーバー設定を画面から作り始められる**（`20260801-server-config-bootstrap`）。
 *
 * `canEditServer` は「保存できるとき」だけ true になる（保存できないボタンを出さない規則）。
 * ところがサーバー設定は**ファイルが無いと path を持たず** `persistable` が false だったため、
 * 画面に「サーバー設定」の選択肢が出なかった——**ファイルを作らないと作れず、
 * 画面から作らないとファイルができない**、という鶏と卵。
 *
 * 個人設定（`connections.json`）は元からそうなっていない。**非対称だっただけ**。
 */
const crypto = SecretCrypto.fromEnv("K", { K: randomBytes(32).toString("hex") })!;
const admin: AuthUser = { username: "root", role: "admin" };
const dir = (): string => mkdtempSync(join(tmpdir(), "bootstrap-"));

describe("既定パス（ファイルが無い）", () => {
  it("**空で始まり、保存できる**（`persistable`）", () => {
    const p = join(dir(), "profiles.json");
    const store = ServerConfigStore.fromFileOrEmpty(p, crypto);
    expect(store.listSystems(admin)).toEqual([]);
    expect(store.persistable).toBe(true);
  });

  it("**保存すると実際にファイルができる**（画面から作り始められる）", async () => {
    const p = join(dir(), "profiles.json");
    const store = ServerConfigStore.fromFileOrEmpty(p, crypto);
    store.addSystem({ name: "AS400", host: "h" }, admin);
    await store.save();
    expect(existsSync(p)).toBe(true);
    const saved = JSON.parse(readFileSync(p, "utf8")) as { systems: { name: string }[] };
    expect(saved.systems[0]!.name).toBe("AS400");
  });

  it("個人設定と同じ振る舞いになった（**非対称を直したのが今回**）", () => {
    const d = dir();
    const server = ServerConfigStore.fromFileOrEmpty(join(d, "profiles.json"), crypto);
    const personal = PersonalConfigStore.fromFile(join(d, "connections.json"), crypto);
    expect(server.persistable).toBe(personal.persistable);
  });
});

describe("既定パス（ファイルがある）", () => {
  it("中身を読む", () => {
    const p = join(dir(), "profiles.json");
    writeFileSync(p, JSON.stringify({ systems: [{ id: "s1", name: "既存", host: "h" }], sessions: [] }));
    const store = ServerConfigStore.fromFileOrEmpty(p, crypto);
    expect(store.listSystems(admin)[0]!.name).toBe("既存");
  });

  it("壊れたファイルは黙って空にしない（**設定が消えたように見せない**）", () => {
    const p = join(dir(), "profiles.json");
    writeFileSync(p, "{ 壊れている");
    expect(() => ServerConfigStore.fromFileOrEmpty(p, crypto)).toThrow();
  });
});

describe("明示指定（`--profiles`）", () => {
  it("**無ければエラー**（打ち間違えたパスで空の設定を立ち上げない）", () => {
    expect(() => ServerConfigStore.fromFile(join(dir(), "nope.json"), crypto)).toThrow(/failed to read/);
  });
});
