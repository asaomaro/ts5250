import { describe, it, expect } from "vitest";
import { mkdtempSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

/**
 * 親work統合test。`tasks.md`「リスク/留意点」が明示していた
 * 「ロックファイル調停プロトコルは...`02`のtest工程で複数ウィンドウを模したシナリオ
 * （同一globalStorageへの2プロセス同時acquire等）を明示的に確認する」を、
 * **本物の別々のOSプロセス**で確認する。
 *
 * `serviceManager.integration.test.ts`の「2つのウィンドウ」テストは同一プロセス内で
 * 順に`await`しており、実プロセス間のファイルI/Oレースにはなっていなかった
 * （`02-extension-core/test-result.md`「未検証の穴」）。ここでは`test/fixtures/acquire-cli.mjs`を
 * 2つ、ほぼ同時に`spawn`し、両方が「ロックが無い」と見て独立にサーバーを起動しようとする
 * 状況を作る。`ServiceManager.acquire()`の「書き込み競合の後始末」（負けた側が自分の
 * 子プロセスを畳んで勝者のポートへ乗り換える）が実プロセス間でも機能することを見る。
 */
const testDir = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(testDir, "..", "..");
const SERVER_MAIN = join(REPO_ROOT, "packages", "server", "dist", "main.js");
const WEB_ROOT = join(REPO_ROOT, "packages", "web-ui", "dist");
const CLI = join(testDir, "fixtures", "acquire-cli.mjs");

interface CliResult {
  port: number;
  spawnedChild: boolean;
  childPid?: number;
}

function runCli(lockFilePath: string, windowId: string, connectionsPath: string, secretKeyFilePath: string) {
  return new Promise<CliResult>((resolvePromise, reject) => {
    const child = spawn(
      process.execPath,
      [CLI, lockFilePath, windowId, SERVER_MAIN, WEB_ROOT, connectionsPath, secretKeyFilePath],
      { stdio: ["ignore", "pipe", "inherit"] }
    );
    let out = "";
    child.stdout.on("data", (buf: Buffer) => {
      out += buf.toString("utf8");
    });
    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`acquire-cli exited ${code}`));
        return;
      }
      resolvePromise(JSON.parse(out.trim()) as CliResult);
    });
    child.on("error", reject);
  });
}

/** `signal 0`は実際にkillしない生存確認（POSIX標準の作法） */
function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function retryUntil(check: () => Promise<boolean>, timeoutMs: number): Promise<boolean> {
  const start = Date.now();
  for (;;) {
    if (await check()) return true;
    if (Date.now() - start > timeoutMs) return false;
    await new Promise((r) => setTimeout(r, 200));
  }
}

/** 候補pidの生存数が1以下に収束するまで待つ（収束しなければタイムアウト時点の生存集合を返す） */
async function waitForAtMostOneAlive(pids: number[], timeoutMs: number): Promise<number[]> {
  const start = Date.now();
  for (;;) {
    const alive = pids.filter(isAlive);
    if (alive.length <= 1 || Date.now() - start > timeoutMs) return alive;
    await new Promise((r) => setTimeout(r, 200));
  }
}

describe("ServiceManager 実プロセス間の競合統合", () => {
  it("2つの別プロセスが同時にacquireしても、最終的に1つのサーバーへ収束する", async () => {
    expect(existsSync(SERVER_MAIN), `ビルドが要ります: npm run build -w @ts5250/server (${SERVER_MAIN})`).toBe(true);
    const dir = mkdtempSync(join(tmpdir(), "svcmgr-mp-it-"));
    const lockFilePath = join(dir, "service.json");
    const connectionsPath = join(dir, "connections.json");
    const secretKeyFilePath = join(dir, ".env");

    const [resultA, resultB] = await Promise.all([
      runCli(lockFilePath, "win-a", connectionsPath, secretKeyFilePath),
      runCli(lockFilePath, "win-b", connectionsPath, secretKeyFilePath)
    ]);

    // 最終的に同じポートへ収束している（片方が自分の起動を畳んで相手へ乗り換えた）
    expect(resultB.port).toBe(resultA.port);

    // killByPid(SIGTERM)は送るだけで完了を待たない（`acquire()`の設計上、後始末は
    // ベストエフォート）。healthzは即断せず短くリトライする——vitestの全ファイル並行実行下では
    // 多数の実サーバーが同時にspawn/killされ、単発の疎通確認だとOS側の後始末待ちの
    // 一瞬に当たることがある（他のtest fileの実プロセス統合testと同じ配慮）
    const winningPort = resultA.port;
    const healthy = await retryUntil(async () => {
      try {
        const res = await fetch(`http://127.0.0.1:${winningPort}/healthz`, { signal: AbortSignal.timeout(500) });
        return res.ok;
      } catch {
        return false;
      }
    }, 5000);
    expect(healthy).toBe(true);

    // どちらか一方だけが実際に子プロセスを起動できていれば競合は起きた（両方ともspawnし、
    // 片方は自分の子を畳んで相手のポートを採用した、または最初から片方だけがspawnした）
    const spawners = [resultA, resultB].filter((r) => r.spawnedChild);
    expect(spawners.length).toBeGreaterThanOrEqual(1);

    // **最終的に生き残っている子プロセスは2つ残らない**（負けた側の後始末漏れ＝プロセスリーク）。
    // `killByPid`のSIGTERMは送るだけで完了を待たない——`packages/server`の`main()`は
    // SIGTERM受信後に非同期の後片付けをしてから`exit(0)`する（research F3）ため、
    // 単発の`isAlive()`は後片付けの最中を「まだ生きている」と誤検出しうる
    // （`serviceManager.integration.test.ts`の`release()`確認と同じ理由でリトライする）
    const candidatePids = spawners.map((r) => r.childPid).filter((pid): pid is number => pid !== undefined);
    const alivePids = await waitForAtMostOneAlive(candidatePids, 5000);
    expect(alivePids.length).toBeLessThanOrEqual(1);

    // 後片付け
    for (const pid of alivePids) process.kill(pid, "SIGTERM");
  }, 30_000);
});
