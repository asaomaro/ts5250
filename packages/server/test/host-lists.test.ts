import { describe, it, expect } from "vitest";
import { buildApp } from "../src/app.js";
import { SessionManager } from "../src/session-manager.js";
import { ProfileStore } from "../src/profiles.js";
import { ConnectionStore } from "../src/connection-store.js";
import { AuditBuffer } from "../src/audit.js";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * ジョブ・オブジェクト・ユーザー一覧の API。
 *
 * 実際の取得は実機でしか確かめられないため、ここでは
 * **入力の検証と、接続情報を持たない場合の扱い**を固定する。
 */
function app() {
  const path = join(mkdtempSync(join(tmpdir(), "hl-")), "connections.json");
  writeFileSync(path, JSON.stringify({ connections: [] }));
  return buildApp({
    sessions: new SessionManager(),
    profiles: new ProfileStore([{ name: "noauth", host: "example.invalid" }]),
    connections: ConnectionStore.fromFile(path),
    audit: new AuditBuffer(),
    version: "test"
  });
}

async function post(a: ReturnType<typeof buildApp>, path: string, body: unknown) {
  return a.request(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
}

describe("一覧 API の入力検証", () => {
  it("未知の種類は 404", async () => {
    const res = await post(app(), "/api/host/list/nosuch", { source: { profile: "noauth" } });
    expect(res.status).toBe(404);
  });

  it("connection と profile の両方を指定したら 400", async () => {
    const res = await post(app(), "/api/host/list/jobs", {
      source: { connection: "a", profile: "b" }
    });
    expect(res.status).toBe(400);
  });

  it("どちらも指定しなければ 400", async () => {
    expect((await post(app(), "/api/host/list/jobs", { source: {} })).status).toBe(400);
  });

  it("知らない項目は拒否する（strict）", async () => {
    const res = await post(app(), "/api/host/list/jobs", {
      source: { profile: "noauth" },
      unexpected: 1
    });
    expect(res.status).toBe(400);
  });

  it("上限を超える max は拒否する", async () => {
    const res = await post(app(), "/api/host/list/jobs", {
      source: { profile: "noauth" },
      max: 99999
    });
    expect(res.status).toBe(400);
  });
});

describe("資格情報を持たない接続設定", () => {
  it("ユーザーとパスワードが無ければ理由の分かるエラーを返す", async () => {
    const res = await post(app(), "/api/host/list/jobs", { source: { profile: "noauth" } });
    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body.error).toMatch(/ユーザーとパスワード/);
    expect(body.code).toBe("CONFIG_ERROR");
  });
});

describe("操作 API", () => {
  it("知らない操作は拒否する（任意の CL を実行させない）", async () => {
    const res = await post(app(), "/api/host/action", {
      source: { profile: "noauth" },
      action: "run-any-command",
      target: {}
    });
    expect(res.status).toBe(400);
  });

  it("ジョブの指定が不完全なら理由を返す", async () => {
    const res = await post(app(), "/api/host/action", {
      source: { profile: "noauth" },
      action: "job-end",
      target: { jobName: "X" }
    });
    expect(res.status).toBe(502);
    expect((await res.json()).error).toMatch(/ジョブの指定が不完全/);
  });

  it("オブジェクトの指定が不完全なら理由を返す", async () => {
    const res = await post(app(), "/api/host/action", {
      source: { profile: "noauth" },
      action: "object-delete",
      target: { objectName: "X" }
    });
    expect(res.status).toBe(502);
    expect((await res.json()).error).toMatch(/オブジェクトの指定が不完全/);
  });

  it("target に知らない項目があれば拒否する", async () => {
    const res = await post(app(), "/api/host/action", {
      source: { profile: "noauth" },
      action: "job-hold",
      target: { jobName: "A", jobUser: "B", jobNumber: "1", extra: "x" }
    });
    expect(res.status).toBe(400);
  });
});
