import { describe, it, expect } from "vitest";
import { mkdtempSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { ServiceManager } from "../src/serviceManager.js";

/**
 * `packages/server`を**実際にspawn**して確認する統合テスト（design.mdの方針どおり、
 * 単体テストの注入されたモックだけでは確認しきれないプロセス管理の正しさを見る。
 * `02-extension-core/tasks.md`のT8）。実機接続（`.env`/`.env.verify`）は使わない
 * ——ここで見るのはプロセスの起動・healthz到達・停止だけ
 */
const REPO_ROOT = resolve(__dirname, "..", "..");
const SERVER_MAIN = join(REPO_ROOT, "packages", "server", "dist", "main.js");
const WEB_ROOT = join(REPO_ROOT, "packages", "web-ui", "dist");

function tempPaths() {
  const dir = mkdtempSync(join(tmpdir(), "svcmgr-it-"));
  return {
    lockFilePath: join(dir, "service.json"),
    connectionsPath: join(dir, "connections.json"),
    secretKeyFilePath: join(dir, ".env")
  };
}

describe("ServiceManager 実プロセス統合", () => {
  it("acquireで実際にサーバーが起動し、healthzに到達し、releaseでプロセスが止まる", async () => {
    expect(existsSync(SERVER_MAIN), `ビルドが要ります: npm run build -w @ts5250/server (${SERVER_MAIN})`).toBe(
      true
    );
    const { lockFilePath, connectionsPath, secretKeyFilePath } = tempPaths();
    const sm = new ServiceManager({
      lockFilePath,
      serverMainPath: SERVER_MAIN,
      webRootPath: WEB_ROOT,
      connectionsPath,
      secretKeyFilePath,
      windowId: "integration-test-window"
    });

    const { port } = await sm.acquire();
    const res = await fetch(`http://127.0.0.1:${port}/healthz`);
    expect(res.ok).toBe(true);
    const body = (await res.json()) as { status: string };
    expect(body.status).toBe("ok");

    await sm.release();

    // プロセスが本当に止まったか（同じportへ接続できなくなる）を確認する。
    // OS側の後片付けに一瞬かかることがあるので短いリトライを許す
    await expect(
      retryUntil(
        async () => {
          try {
            await fetch(`http://127.0.0.1:${port}/healthz`, { signal: AbortSignal.timeout(300) });
            return false; // まだ応答するなら失敗
          } catch {
            return true; // 接続できなくなっていれば成功
          }
        },
        5000
      )
    ).resolves.toBe(true);
  }, 30_000);

  it("2つのウィンドウが同じロックを共有する（2つ目はspawnせず既存ポートを再利用する）", async () => {
    const { lockFilePath, connectionsPath, secretKeyFilePath } = tempPaths();
    const base = { serverMainPath: SERVER_MAIN, webRootPath: WEB_ROOT, connectionsPath, secretKeyFilePath };
    const a = new ServiceManager({ ...base, lockFilePath, windowId: "win-a" });
    const b = new ServiceManager({ ...base, lockFilePath, windowId: "win-b" });

    const ra = await a.acquire();
    const rb = await b.acquire();
    expect(rb.port).toBe(ra.port); // 同じサーバーを共有している

    await a.release(); // win-bがまだ使っているので、この時点ではプロセスは生きているはず
    const stillUp = await fetch(`http://127.0.0.1:${ra.port}/healthz`).then(
      (r) => r.ok,
      () => false
    );
    expect(stillUp).toBe(true);

    await b.release(); // 最後の1つが抜けたので止まる
  }, 30_000);
});

async function retryUntil(check: () => Promise<boolean>, timeoutMs: number): Promise<boolean> {
  const start = Date.now();
  for (;;) {
    if (await check()) return true;
    if (Date.now() - start > timeoutMs) return false;
    await new Promise((r) => setTimeout(r, 200));
  }
}
