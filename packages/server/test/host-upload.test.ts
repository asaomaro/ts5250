import { describe, it, expect } from "vitest";
import { buildApp } from "../src/app.js";
import { SessionManager } from "../src/session-manager.js";
import { ConfigResolver } from "../src/config-resolver.js";
import { PersonalConfigStore, ServerConfigStore } from "../src/config-store.js";
import { AuditBuffer } from "../src/audit.js";

/**
 * 取り込み API。実際の書き込みは実機でしか確かめられないため、ここでは
 * **入力の検証・上限の強制・識別子の絞り込み・認可の入口**を固定する。
 *
 * ⚠ このルートは **IBM i に書き込む**。上限をクライアント任せにすると守れないので、
 * サーバー側で強制されていることを回帰として残す（AGENTS.md §5）。
 */
function app() {
  const server = new ServerConfigStore({
    systems: [{ id: "noauth", name: "noauth", host: "example.invalid" }],
    sessions: [{ id: "noauth-d", name: "noauth-d", system: "noauth", sessionType: "display" }]
  });
  const personal = new PersonalConfigStore({
    systems: [{ id: "s-1", name: "alice の機", host: "h2", owner: "alice" }],
    sessions: []
  });
  return buildApp({
    sessions: new SessionManager(),
    resolver: new ConfigResolver(server, personal),
    audit: new AuditBuffer(),
    version: "test"
  });
}

async function post(body: unknown) {
  return app().request("/api/host/upload", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
}

const SRC = { system: "srv:noauth" };
const BASE = { source: SRC, library: "MYLIB", file: "TESTPF", columns: ["A"], rows: [["x"]] };

describe("入力の検証", () => {
  it("接続先を指定しなければ 400", async () => {
    expect((await post({ ...BASE, source: {} })).status).toBe(400);
  });

  it("ライブラリ・ファイルは必須", async () => {
    expect((await post({ ...BASE, library: undefined })).status).toBe(400);
    expect((await post({ ...BASE, file: undefined })).status).toBe(400);
  });

  it("列が空なら拒否する", async () => {
    expect((await post({ ...BASE, columns: [] })).status).toBe(400);
  });

  it("知らない項目は拒否する（strict）", async () => {
    expect((await post({ ...BASE, unexpected: 1 })).status).toBe(400);
  });

  it("行の値は文字列か null に限る", async () => {
    expect((await post({ ...BASE, rows: [[123]] })).status).toBe(400);
    expect((await post({ ...BASE, rows: [[null]] })).status).not.toBe(422);
  });
});

describe("行数の上限はサーバー側で強制される", () => {
  it("**上限を超える行数を拒否する**（クライアントを書き換えても超えられない）", async () => {
    const rows = Array.from({ length: 10_001 }, () => ["x"]);
    expect((await post({ ...BASE, rows })).status).toBe(400);
  });

  it("上限ちょうどは入力検証を通る（接続まで進んで別の理由で失敗する）", async () => {
    const rows = Array.from({ length: 10_000 }, () => ["x"]);
    const res = await post({ ...BASE, rows });
    expect((await res.json()).code).toBe("CONFIG_ERROR"); // 資格情報が無い
  });
});

describe("識別子の絞り込み（SQL への連結を避けられない箇所の防壁）", () => {
  it.each([
    ["引用符", "MAR'O1"],
    ["セミコロン", "MYLIB;X"],
    ["空白", "MAR O1"],
    ["長すぎる", "ABCDEFGHIJK"],
    ["SQL 断片", "X' OR '1'='1"]
  ])("**%s を含むライブラリ名を拒否する**", async (_name, library) => {
    const res = await post({ ...BASE, library });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/ライブラリ名/);
  });

  it("同じ規則がファイル名にも効く", async () => {
    const res = await post({ ...BASE, file: "A;B" });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/ファイル名/);
  });
});

describe("資格情報を持たない接続設定", () => {
  it("理由の分かるエラーを返す", async () => {
    const res = await post(BASE);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/ユーザーとパスワード/);
    expect(body.code).toBe("CONFIG_ERROR");
  });
});

describe("認可", () => {
  it("存在しない参照は 404", async () => {
    expect((await post({ ...BASE, source: { system: "srv:nosuch" } })).status).toBe(404);
  });

  it("他人の個人設定は通さない（解決は ConfigResolver に委ねる）", async () => {
    const res = await post({ ...BASE, source: { system: "own:s-1" } });
    expect([400, 403, 404]).toContain(res.status);
  });
});
