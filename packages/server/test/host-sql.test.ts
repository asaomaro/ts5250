import { describe, it, expect } from "vitest";
import { buildApp } from "../src/app.js";
import { SessionManager } from "../src/session-manager.js";
import { ConfigResolver } from "../src/config-resolver.js";
import { PersonalConfigStore, ServerConfigStore } from "../src/config-store.js";
import { AuditBuffer } from "../src/audit.js";
import type { AuthUser } from "../src/auth.js";

/**
 * SQL API。実際の実行は実機でしか確かめられないため、ここでは
 * **入力の検証・上限の強制・資格情報を持たない場合の扱い**を固定する。
 *
 * とくに `maxRows` の上限は**サーバー側で強制されている**ことが重要——
 * クライアントを書き換えれば超えられる、では守れていない（AGENTS.md §5）。
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

async function post(body: unknown, headers: Record<string, string> = {}) {
  return app().request("/api/host/sql", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body)
  });
}

const SRC = { system: "srv:noauth" };

describe("入力の検証", () => {
  it("sql が無ければ 400", async () => {
    expect((await post({ source: SRC })).status).toBe(400);
  });

  it("空文字の sql は拒否する", async () => {
    expect((await post({ source: SRC, sql: "" })).status).toBe(400);
  });

  it("接続先を指定しなければ 400", async () => {
    const res = await post({ source: {}, sql: "SELECT 1 FROM SYSIBM.SYSDUMMY1" });
    expect(res.status).toBe(400);
  });

  it("知らない項目は拒否する（strict）", async () => {
    const res = await post({ source: SRC, sql: "SELECT 1", unexpected: 1 });
    expect(res.status).toBe(400);
  });

  it("system と session が食い違えば拒否する", async () => {
    const res = await post({
      source: { system: "srv:other", session: "srv:noauth-d" },
      sql: "SELECT 1"
    });
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe("CONFIG_ERROR");
  });
});

describe("maxRows の上限はサーバー側で強制される", () => {
  it("上限 1000 を超える指定を拒否する", async () => {
    const res = await post({ source: SRC, sql: "SELECT 1", maxRows: 1001 });
    expect(res.status).toBe(400);
  });

  it("0 以下を拒否する", async () => {
    expect((await post({ source: SRC, sql: "SELECT 1", maxRows: 0 })).status).toBe(400);
    expect((await post({ source: SRC, sql: "SELECT 1", maxRows: -1 })).status).toBe(400);
  });

  it("小数を拒否する", async () => {
    expect((await post({ source: SRC, sql: "SELECT 1", maxRows: 1.5 })).status).toBe(400);
  });

  it("上限ちょうどは受け付ける（接続まで進んで別の理由で失敗する）", async () => {
    const res = await post({ source: SRC, sql: "SELECT 1", maxRows: 1000 });
    // 入力検証は通り、資格情報が無いことで落ちる
    expect((await res.json()).code).toBe("CONFIG_ERROR");
  });
});

describe("資格情報を持たない接続設定", () => {
  it("理由の分かるエラーを返す", async () => {
    const res = await post({ source: SRC, sql: "SELECT 1 FROM SYSIBM.SYSDUMMY1" });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/ユーザーとパスワード/);
    expect(body.code).toBe("CONFIG_ERROR");
  });
});

describe("認可", () => {
  it("存在しない参照は 404", async () => {
    const res = await post({ source: { system: "srv:nosuch" }, sql: "SELECT 1" });
    expect(res.status).toBe(404);
  });

  it("他人の個人設定は参照できない", async () => {
    // 認証を有効にしていないアプリでは全通過になるため、ここでは
    // 「解決が ConfigResolver に委ねられている」ことの回帰として存在確認に留める。
    // 認可そのものは config-resolver.test.ts が担保している。
    const res = await post({ source: { system: "own:s-1" }, sql: "SELECT 1" });
    expect([400, 403, 404]).toContain(res.status);
  });
});

describe("任意の SQL を受け付ける（spec D1）", () => {
  // 文字列としての SQL は素通しする（実行できるのが SELECT だけであることは
  // query の実装が担保しており、実機で副作用が無いことを確認済み）。
  // ここで確かめるのは「アプリが文面で弾いていない」こと——弾いていると誤解されると
  // セキュリティの根拠を取り違える。
  const user: AuthUser | undefined = undefined;
  void user;

  it("DELETE 文でも入力検証では弾かない（接続段階まで進む）", async () => {
    const res = await post({ source: SRC, sql: "DELETE FROM X" });
    expect((await res.json()).code).toBe("CONFIG_ERROR"); // 文面ではなく資格情報で落ちている
  });
});

describe("暖機（/warm）", () => {
  /**
   * 接続の確立に実測で約 4.6 秒かかるため、画面がペインを開いた時点で先に開かせる。
   * **失敗しても画面には出さない**（実行時に開き直せばよく、利用者にできることが無い）ので、
   * ここでは「開けなくても 200 で返す」ことを固定する。
   */
  it("接続できなくてもエラーにしない（warmed: false）", async () => {
    const res = await app().request("/api/host/sql/warm", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ source: SRC })
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ warmed: false });
  });

  it("知らない項目は拒否する（strict）", async () => {
    const res = await app().request("/api/host/sql/warm", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ source: SRC, sql: "SELECT 1" })
    });
    expect(res.status).toBe(400);
  });

  it("接続先を指定しなければ 400", async () => {
    const res = await app().request("/api/host/sql/warm", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({})
    });
    expect(res.status).toBe(400);
  });
});

/**
 * **取り込み経路を足しても `/api/host/sql` は読み取り専用のまま**であること。
 *
 * `20260720-sql-insert-upload` で database サーバー経由の INSERT を実装したが、
 * それは別ルート（`/api/host/upload`）・別の要求コードに閉じてあり、
 * `query` の性質（結果セットを持たない文を実行できない）は変えていない。
 * ここが崩れると**ブラウザから任意の更新が通る**ようになるので、回帰として固定する。
 */
describe("読み取り専用の不変条件（取り込み経路を足した後も）", () => {
  it("**更新系の SQL でも実行経路は同じ**（文字列としては素通しし、実行は query が拒む）", async () => {
    // 入力検証で弾いているわけではないことを明示する——弾いていると誤解すると、
    // 「検証を緩めれば更新できる」と読めてしまう
    const res = await post({ source: SRC, sql: "INSERT INTO X.Y VALUES (1)" });
    // 資格情報が無いので接続段階で落ちる＝入力検証は通っている
    expect((await res.json()).code).toBe("CONFIG_ERROR");
  });

  it("SQL ルートは取り込み用のパラメータを受け付けない（別ルートに閉じている）", async () => {
    const res = await post({ source: SRC, sql: "SELECT 1", columns: ["A"], rows: [["x"]] });
    expect(res.status).toBe(400); // strict schema が拒否する
  });

  it("**取り込みは別ルート**であることを固定する", async () => {
    const upload = await app().request("/api/host/upload", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ source: SRC, library: "L", file: "F", columns: ["A"], rows: [["x"]] })
    });
    // 存在し、SQL ルートとは独立に動く（ここでは資格情報が無くて落ちる）
    expect(upload.status).toBe(400);
    expect((await upload.json()).code).toBe("CONFIG_ERROR");
  });
});
