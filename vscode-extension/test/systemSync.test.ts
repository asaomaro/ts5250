import { describe, it, expect, vi } from "vitest";
import { mkdtempSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { syncSystem } from "../src/systemSync.js";

function tempMappingPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "systemsync-"));
  return join(dir, "systemRefs.json");
}

const baseInput = { documentUri: "file:///a.ts5250", name: "a.ts5250", host: "AS400" };

describe("syncSystem: 初回登録", () => {
  it("対応表に無ければPOSTで新規登録し、返ってきたref（既にown:接頭辞付き）を対応表へ保存する", async () => {
    const mappingFilePath = tempMappingPath();
    const fetchFn = vi.fn(async (url: string, init: RequestInit) => {
      expect(url).toBe("http://127.0.0.1:1234/api/systems");
      expect(init.method).toBe("POST");
      const body = JSON.parse(init.body as string);
      expect(body).toMatchObject({ name: "a.ts5250", host: "AS400", signonUser: "U", password: "P" });
      // 実サーバーの応答は`{system:{ref, ...}}`——`id`という欄は無い
      // （test/systemSync.integration.test.ts で実際に確認済み）
      return new Response(JSON.stringify({ system: { ref: "own:s-assigned-1" } }), { status: 201 });
    });

    const ref = await syncSystem(
      { ...baseInput, user: "U", password: "P" },
      { port: 1234, mappingFilePath, fetchFn: fetchFn as unknown as typeof fetch }
    );

    expect(ref).toBe("own:s-assigned-1");
    expect(existsSync(mappingFilePath)).toBe(true);
    const mapping = JSON.parse(readFileSync(mappingFilePath, "utf8")) as Record<string, string>;
    expect(mapping[baseInput.documentUri]).toBe("own:s-assigned-1");
  });

  it("POSTが失敗（非2xx）したら例外を投げる", async () => {
    const mappingFilePath = tempMappingPath();
    const fetchFn = vi.fn(async () => new Response("", { status: 500 }));
    await expect(
      syncSystem(baseInput, { port: 1, mappingFilePath, fetchFn: fetchFn as unknown as typeof fetch })
    ).rejects.toThrow();
  });
});

describe("syncSystem: 2回目以降", () => {
  it("対応表にrefがあればPUTで同期する（POSTは呼ばない）", async () => {
    const mappingFilePath = tempMappingPath();
    const fetchFn = vi.fn(async (url: string, init: RequestInit) => {
      if (init.method === "POST")
        return new Response(JSON.stringify({ system: { ref: "own:s-1" } }), { status: 201 });
      expect(url).toBe("http://127.0.0.1:1234/api/systems/own:s-1");
      expect(init.method).toBe("PUT");
      return new Response(JSON.stringify({ system: { ref: "own:s-1" } }), { status: 200 });
    });
    const opts = { port: 1234, mappingFilePath, fetchFn: fetchFn as unknown as typeof fetch };

    await syncSystem(baseInput, opts); // 初回: POST
    fetchFn.mockClear();
    const ref = await syncSystem(baseInput, opts); // 2回目: PUT

    expect(ref).toBe("own:s-1");
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(fetchFn.mock.calls[0]![1]).toMatchObject({ method: "PUT" });
  });

  it("PUTが404以外（500等）で失敗したら例外を投げる。POSTへフォールバックしない", async () => {
    const mappingFilePath = tempMappingPath();
    const seedFetch = vi.fn(async () => new Response(JSON.stringify({ system: { ref: "own:s-1" } }), { status: 201 }));
    const opts = { port: 1, mappingFilePath, fetchFn: seedFetch as unknown as typeof fetch };
    await syncSystem(baseInput, opts); // own:s-1をキャッシュさせる

    let postCalled = false;
    const fetchFn = vi.fn(async (_url: string, init: RequestInit) => {
      if (init.method === "POST") postCalled = true;
      return new Response("", { status: 500 });
    });
    await expect(
      syncSystem(baseInput, { ...opts, fetchFn: fetchFn as unknown as typeof fetch })
    ).rejects.toThrow();
    expect(postCalled).toBe(false);
  });

  it("PUTが404等で失敗したらPOSTへフォールバックし、対応表を新しいrefで上書きする", async () => {
    const mappingFilePath = tempMappingPath();
    let putCalled = false;
    const fetchFn = vi.fn(async (_url: string, init: RequestInit) => {
      if (init.method === "PUT") {
        putCalled = true;
        return new Response("", { status: 404 });
      }
      return new Response(JSON.stringify({ system: { ref: "own:s-2" } }), { status: 201 });
    });
    const opts = { port: 1, mappingFilePath, fetchFn: fetchFn as unknown as typeof fetch };

    // 最初にown:s-1をキャッシュさせておく（同じmappingFilePathへ別サーバーへの登録を装う）
    const seedFetch = vi.fn(async () => new Response(JSON.stringify({ system: { ref: "own:s-1" } }), { status: 201 }));
    await syncSystem(baseInput, { ...opts, fetchFn: seedFetch as unknown as typeof fetch });

    const ref = await syncSystem(baseInput, opts);

    expect(putCalled).toBe(true);
    expect(ref).toBe("own:s-2");
    const mapping = JSON.parse(readFileSync(mappingFilePath, "utf8")) as Record<string, string>;
    expect(mapping[baseInput.documentUri]).toBe("own:s-2");
  });
});
