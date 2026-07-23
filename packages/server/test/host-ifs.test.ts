import { describe, it, expect } from "vitest";
import { As400Error } from "@as400web/core";
import { buildApp, DEFAULT_IFS_ZIP_MAX_BYTES, DEFAULT_IFS_ZIP_MAX_FILES } from "../src/app.js";
import { SessionManager } from "../src/session-manager.js";
import { ConfigResolver } from "../src/config-resolver.js";
import { PersonalConfigStore, ServerConfigStore } from "../src/config-store.js";
import { AuditBuffer } from "../src/audit.js";
import { statusOf } from "../src/host-api.js";

/**
 * IFS の HTTP ルート。
 *
 * 実際の取得は実機でしか確かめられないため、ここでは
 * **入力の検証と、エラーコードからステータスへの写像**を固定する。
 * 写像は 01 の review で「全部 502 に潰れていた」と指摘された箇所なので、回帰資産にする。
 */
function app() {
  const server = new ServerConfigStore({
    systems: [{ id: "noauth", name: "noauth", host: "example.invalid" }],
    sessions: [{ id: "noauth-d", name: "noauth-d", system: "noauth", sessionType: "display" }]
  });
  return buildApp({
    sessions: new SessionManager(),
    resolver: new ConfigResolver(server, new PersonalConfigStore()),
    audit: new AuditBuffer(),
    version: "test"
  });
}

async function post(path: string, body: unknown) {
  return app().request(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
}

const SOURCE = { system: "srv:noauth" };
const ROUTES = [
  "/api/host/ifs/list",
  "/api/host/ifs/read",
  "/api/host/ifs/write",
  "/api/host/ifs/mkdir",
  "/api/host/ifs/delete",
  "/api/host/ifs/download",
  "/api/host/ifs/zip"
] as const;

describe("ルートが登録されている", () => {
  it("7 本すべてが 404 ではない（登録漏れの検出）", async () => {
    for (const route of ROUTES) {
      const res = await post(route, {});
      // 入力不足で 400 になるのが正。404 なら登録されていない
      expect(res.status, route).not.toBe(404);
    }
  });
});

describe("入力の検証", () => {
  it("path が無ければ 400", async () => {
    for (const route of ROUTES) {
      const res = await post(route, { source: SOURCE });
      expect(res.status, route).toBe(400);
    }
  });

  /** 素通しすると `""` → `"/*"` になってファイルシステムのルートを一覧してしまう */
  it("空の path は受け付けない", async () => {
    const res = await post("/api/host/ifs/list", { source: SOURCE, path: "" });
    expect(res.status).toBe(400);
  });

  it("知らない項目を渡したら拒否する（strict）", async () => {
    const res = await post("/api/host/ifs/list", { source: SOURCE, path: "/d", nosuch: 1 });
    expect(res.status).toBe(400);
  });

  /** 範囲外は core 側でも弾かれるが、HTTP の入口で落とした方が原因が分かる */
  it("maxCount の範囲外は 400", async () => {
    for (const maxCount of [0, 65_536, 1.5]) {
      const res = await post("/api/host/ifs/list", { source: SOURCE, path: "/d", maxCount });
      expect(res.status, String(maxCount)).toBe(400);
    }
  });

  it("encoding は utf8 か base64 のみ", async () => {
    const res = await post("/api/host/ifs/read", {
      source: SOURCE,
      path: "/d/f",
      encoding: "sjis"
    });
    expect(res.status).toBe(400);
  });

  it("write に content が無ければ 400", async () => {
    const res = await post("/api/host/ifs/write", { source: SOURCE, path: "/d/f" });
    expect(res.status).toBe(400);
  });

  /** 既存のホスト API と揃った挙動（`SESSION_NOT_FOUND` → 404） */
  it("未知のシステムは 404", async () => {
    const res = await post("/api/host/ifs/list", { source: { system: "srv:nosuch" }, path: "/d" });
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ code: "SESSION_NOT_FOUND" });
  });
});

/**
 * **01 の review M2 で「全部 502 に潰れていた」と指摘された箇所。**
 * core が投げ分けるコードが、ここで意図どおりのステータスに写ることを固定する。
 */
describe("エラーコードから HTTP ステータスへの写像", () => {
  const cases: [string, number][] = [
    ["NOT_FOUND", 404],
    ["ACCESS_DENIED", 403],
    ["ALREADY_EXISTS", 409],
    ["RESOURCE_BUSY", 409],
    // 「中身が残っている」は待っても権限を足しても変わらないが、中を消せば通る
    ["NOT_EMPTY", 409],
    ["FORBIDDEN", 403],
    ["CONFIG_ERROR", 400],
    // 上流との通信失敗だけが 502
    ["CONNECT_FAILED", 400],
    ["PROTOCOL_ERROR", 502]
  ];

  for (const [code, status] of cases) {
    it(`${code} → ${status}`, () => {
      expect(statusOf(new As400Error(code as "NOT_FOUND", "x"))).toBe(status);
    });
  }

  /** 502 は「ホストが落ちている」の意味に限る。存在しないパスをこれにしない */
  it("存在しないパスを 502 にしない", () => {
    expect(statusOf(new As400Error("NOT_FOUND", "no such directory"))).not.toBe(502);
  });
});

describe("zip の既定の上限", () => {
  /** 実効 100KB/s なので、20MB は最悪で約 3.5 分に相当する */
  it("20MB / 500 ファイル", () => {
    expect(DEFAULT_IFS_ZIP_MAX_BYTES).toBe(20 * 1024 * 1024);
    expect(DEFAULT_IFS_ZIP_MAX_FILES).toBe(500);
  });

  /** zip64 非対応なので、上限そのものが 4GB を超えてはいけない */
  it("既定は zip64 の境界より十分小さい", () => {
    expect(DEFAULT_IFS_ZIP_MAX_BYTES).toBeLessThan(0xffffffff);
  });
});
