import { describe, it, expect } from "vitest";
import { mkdtempSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { syncSystem } from "../src/systemSync.js";

/**
 * 親work統合test。`03-sql-ifs/tasks.md`の親（`tasks.md`「リスク/留意点」）が明示していた
 * 「`.ts5250`の`passwordEnc`を書き換えたら`connections.json`側も追随するか」を、
 * **実際に起動したサーバー**＋**実際に書かれた`connections.json`の生ファイル**で確認する
 * （`systemSync.integration.test.ts`はhost/portの同期は確認済みだが、passwordは
 * 未検証のまま残っていた——`03-sql-ifs/test-result.md`「未検証の穴」）。
 */
const REPO_ROOT = resolve(__dirname, "..", "..");
const SERVER_MAIN = join(REPO_ROOT, "packages", "server", "dist", "main.js");

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

describe("syncSystem のパスワード実プロセス統合（connections.jsonへの追随）", () => {
  it("2回目のsyncSystemで新しいpasswordEncへ更新され、平文はファイルに残らない", async () => {
    expect(existsSync(SERVER_MAIN), `ビルドが要ります: npm run build -w @ts5250/server (${SERVER_MAIN})`).toBe(true);
    const dir = mkdtempSync(join(tmpdir(), "systemsync-pw-it-"));
    const connectionsPath = join(dir, "connections.json");
    const secretKeyFilePath = join(dir, ".env");
    const mappingFilePath = join(dir, "systemRefs.json");
    const port = 35112;
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

      const input = {
        documentUri: "file:///real-password.ts5250",
        name: "real-password.ts5250",
        host: "TESTHOST",
        user: "TESTUSER"
      };
      await syncSystem({ ...input, password: "first-secret-value" }, { port, mappingFilePath });

      const afterFirst = JSON.parse(readFileSync(connectionsPath, "utf8")) as {
        systems: Array<{ id: string; signon?: { passwordEnc?: string } }>;
      };
      expect(afterFirst.systems).toHaveLength(1);
      const passwordEncAfterFirst = afterFirst.systems[0]?.signon?.passwordEnc;
      expect(passwordEncAfterFirst).toBeDefined();
      expect(passwordEncAfterFirst).not.toBe("first-secret-value"); // 平文で保存していない

      // `.ts5250`側でパスワードが書き換わった状況を再現する（同じdocumentUri→同じ既存ref→PUT）
      await syncSystem({ ...input, password: "second-secret-value" }, { port, mappingFilePath });

      const afterSecond = JSON.parse(readFileSync(connectionsPath, "utf8")) as {
        systems: Array<{ id: string; signon?: { passwordEnc?: string } }>;
      };
      expect(afterSecond.systems).toHaveLength(1); // 新規登録が増えていない（同じidへPUTされた）
      expect(afterSecond.systems[0]?.id).toBe(afterFirst.systems[0]?.id);
      const passwordEncAfterSecond = afterSecond.systems[0]?.signon?.passwordEnc;
      expect(passwordEncAfterSecond).toBeDefined();
      expect(passwordEncAfterSecond).not.toBe(passwordEncAfterFirst); // 新しいpasswordEncへ追随した

      const rawFileText = readFileSync(connectionsPath, "utf8");
      expect(rawFileText).not.toContain("first-secret-value");
      expect(rawFileText).not.toContain("second-secret-value");
    } finally {
      child.kill("SIGTERM");
    }
  }, 20_000);
});
