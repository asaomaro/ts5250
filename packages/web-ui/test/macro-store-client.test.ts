import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { PublicMacro } from "@as400web/server";
import { macrosStore } from "../src/stores/macros.js";

/**
 * マクロストア（REST クライアント）。受け入れ基準 A6（一覧・改名・削除）と
 * A7（再読み込みで残る＝サーバーから取り直せる）を、fetch を差し替えて確認する。
 *
 * **このストアは秘密を持たない**。サーバーが返すのは `hasSecret` と `secretFields` までで、
 * 値は再生時にサーバー内部で差し込まれる（spec D11）。
 */

function macro(over: Partial<PublicMacro> = {}): PublicMacro {
  return { id: "m-1", name: "サインオン", createdAt: 1, updatedAt: 1, hasSecret: false, steps: [], ...over };
}

let fetchMock: ReturnType<typeof vi.fn>;

function jsonRes(body: unknown, ok = true, status = 200): Response {
  return { ok, status, json: () => Promise.resolve(body) } as unknown as Response;
}

beforeEach(() => {
  macrosStore.macros = [];
  macrosStore.canStoreSecrets = false;
  macrosStore.loaded = false;
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

describe("マクロストア: 一覧の取得（A7）", () => {
  it("サーバーから取り直して一覧と canStoreSecrets を反映する", async () => {
    fetchMock.mockResolvedValue(jsonRes({ macros: [macro()], canStoreSecrets: true }));

    await macrosStore.refresh();

    expect(fetchMock).toHaveBeenCalledWith("/api/macros");
    expect(macrosStore.macros).toHaveLength(1);
    expect(macrosStore.canStoreSecrets).toBe(true);
    expect(macrosStore.loaded).toBe(true);
  });

  it("id で引ける", async () => {
    fetchMock.mockResolvedValue(jsonRes({ macros: [macro(), macro({ id: "m-2" })], canStoreSecrets: false }));
    await macrosStore.refresh();
    expect(macrosStore.get("m-2")?.id).toBe("m-2");
    expect(macrosStore.get("m-nope")).toBeUndefined();
  });

  it("取得に失敗しても落ちず、空になる", async () => {
    fetchMock.mockResolvedValue(jsonRes({}, false, 500));
    await macrosStore.refresh();
    expect(macrosStore.macros).toEqual([]);
  });

  it("通信そのものが失敗しても落ちない", async () => {
    fetchMock.mockRejectedValue(new Error("offline"));
    await expect(macrosStore.refresh()).resolves.toBeUndefined();
    expect(macrosStore.macros).toEqual([]);
  });
});

describe("マクロストア: 作成（A1）", () => {
  it("POST して一覧を取り直す", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonRes({ macro: macro() }, true, 201))
      .mockResolvedValueOnce(jsonRes({ macros: [macro()], canStoreSecrets: true }));

    const created = await macrosStore.create({
      name: "サインオン",
      steps: [
        {
          screen: { rows: 24, cols: 80, targets: [] },
          fields: [],
          key: "Enter",
          cursor: { row: 1, col: 1 }
        }
      ]
    });

    expect(created.id).toBe("m-1");
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/macros");
    expect(init.method).toBe("POST");
    expect(macrosStore.macros).toHaveLength(1);
  });

  it("サーバーのエラー本文をそのまま投げる（鍵未設定の案内が UI に出る）", async () => {
    fetchMock.mockResolvedValue(
      jsonRes({ error: "secret key not configured; cannot store macro secrets" }, false, 400)
    );
    await expect(
      macrosStore.create({
        name: "x",
        steps: [{ screen: { rows: 24, cols: 80, targets: [] }, fields: [], key: "Enter", cursor: { row: 1, col: 1 } }]
      })
    ).rejects.toThrow(/secret key not configured/);
  });
});

describe("マクロストア: 改名・削除（A6）", () => {
  it("改名は PUT して一覧を取り直す", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonRes({ macro: macro({ name: "改名後" }) }))
      .mockResolvedValueOnce(jsonRes({ macros: [macro({ name: "改名後" })], canStoreSecrets: false }));

    const renamed = await macrosStore.rename("m-1", "改名後");

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/macros/m-1");
    expect(init.method).toBe("PUT");
    expect(JSON.parse(String(init.body))).toEqual({ name: "改名後" });
    expect(renamed.name).toBe("改名後");
    expect(macrosStore.macros[0]!.name).toBe("改名後");
  });

  it("削除は DELETE して一覧から消える", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonRes({ ok: true }))
      .mockResolvedValueOnce(jsonRes({ macros: [], canStoreSecrets: false }));

    await macrosStore.remove("m-1");

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/macros/m-1");
    expect(init.method).toBe("DELETE");
    expect(macrosStore.macros).toHaveLength(0);
  });

  it("id は URL エンコードされる", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonRes({ ok: true }))
      .mockResolvedValueOnce(jsonRes({ macros: [], canStoreSecrets: false }));
    await macrosStore.remove("m-1/../x");
    expect(fetchMock.mock.calls[0]![0]).toBe("/api/macros/m-1%2F..%2Fx");
  });

  it("他人のマクロへの操作（403）はエラーとして伝わる", async () => {
    fetchMock.mockResolvedValue(jsonRes({ error: "forbidden: not the owner of this session" }, false, 403));
    await expect(macrosStore.rename("m-1", "奪う")).rejects.toThrow(/forbidden/);
  });

  it("本文が JSON でない失敗応答は HTTP ステータスを返す", async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 502,
      json: () => Promise.reject(new Error("not json"))
    } as unknown as Response);
    await expect(macrosStore.remove("m-1")).rejects.toThrow("HTTP 502");
  });
});
