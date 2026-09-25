import { describe, it, expect } from "vitest";
import { mkdtempSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { syncSystem } from "../src/systemSync.js";

/**
 * `packages/server`を**実際にspawn**して`syncSystem`を確認する統合テスト
 * （`03-sql-ifs/tasks.md`のT3）。実機接続（`.env`/`.env.verify`）は使わない
 * ——ここで見るのは登録・同期の正しさであって実際のIBM iへの接続ではない
 * （実機接続は01-embed-uiの`SpoolPane.vue`等が既に担っている）。
 */
const REPO_ROOT = resolve(__dirname, "..", "..");
const SERVER_MAIN = join(REPO_ROOT, "packages", "server", "dist", "main.js");

function tempPaths() {
  const dir = mkdtempSync(join(tmpdir(), "systemsync-it-"));
  return {
    connectionsPath: join(dir, "connections.json"),
    secretKeyFilePath: join(dir, ".env"),
    mappingFilePath: join(dir, "systemRefs.json")
  };
}

async function waitHealthy(port: number): Promise<void> {
  for (let i = 0; i < 50; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/healthz`);
      if (res.ok) return;
    } catch {
      /* まだ起動していない */
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error("server did not become healthy");
}

async function withServer(fn: (port: number) => Promise<void>): Promise<void> {
  expect(existsSync(SERVER_MAIN), `ビルドが要ります: npm run build -w @ts5250/server (${SERVER_MAIN})`).toBe(true);
  const { connectionsPath, secretKeyFilePath } = tempPaths();
  const port = 35111;
  const child: ChildProcess = spawn(
    process.execPath,
    [
      SERVER_MAIN,
      "--http",
      String(port),
      "--connections",
      connectionsPath,
      "--auto-secret-key",
      "--secret-key-file",
      secretKeyFilePath
    ],
    { stdio: ["ignore", "ignore", "ignore"] }
  );
  try {
    await waitHealthy(port);
    await fn(port);
  } finally {
    child.kill("SIGTERM");
  }
}

describe("syncSystem 実プロセス統合", () => {
  it("実際に起動したサーバーへ登録でき、GET /api/systemsで内容を確認できる", async () => {
    await withServer(async (port) => {
      const { mappingFilePath } = tempPaths();
      const ref = await syncSystem(
        { documentUri: "file:///real.ts5250", name: "real.ts5250", host: "TESTHOST", port: 992 },
        { port, mappingFilePath }
      );
      expect(ref).toMatch(/^own:/);

      const res = await fetch(`http://127.0.0.1:${port}/api/systems`);
      const body = (await res.json()) as { systems: Array<{ ref: string; host: string }> };
      const found = body.systems.find((s) => s.ref === ref);
      expect(found).toBeDefined();
      expect(found?.host).toBe("TESTHOST");
    });
  }, 20_000);

  it("2回目のsyncSystemは同じidへPUTで同期する（systemが増えない）", async () => {
    await withServer(async (port) => {
      const { mappingFilePath } = tempPaths();
      const input = { documentUri: "file:///real2.ts5250", name: "real2.ts5250", host: "H1" };
      const ref1 = await syncSystem(input, { port, mappingFilePath });
      const ref2 = await syncSystem({ ...input, host: "H2" }, { port, mappingFilePath });

      expect(ref2).toBe(ref1);
      const res = await fetch(`http://127.0.0.1:${port}/api/systems`);
      const body = (await res.json()) as { systems: Array<{ ref: string; host: string }> };
      const matching = body.systems.filter((s) => s.ref === ref1);
      expect(matching).toHaveLength(1);
      expect(matching[0]?.host).toBe("H2"); // 2回目の内容で上書きされている
    });
  }, 20_000);
});
