import { describe, it, expect, vi } from "vitest";
import { mkdtempSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import { ServiceManager, type LockFile } from "../src/serviceManager.js";

function tempLockPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "svcmgr-"));
  return join(dir, "service.json");
}

/**
 * `spawn()`の戻り値（`ChildProcess`）の最小フェイク。実際の`EventEmitter`を使う——
 * `acquire()`が`child.once("error", ...)`を配線するため、素のオブジェクトだと落ちる
 * （taskcheck T7の指摘でspawn失敗の伝播を追加した際に発覚）
 */
function fakeChild(pid: number): EventEmitter & { pid: number } {
  return Object.assign(new EventEmitter(), { pid });
}

/** `process.kill`相当のfake（`kill(pid, sig)`を記録するだけ） */
function fakeKill() {
  return vi.spyOn(process, "kill").mockImplementation(() => true);
}

function baseOptions(lockFilePath: string, windowId: string, nowMs: { value: number }) {
  return {
    lockFilePath,
    serverMainPath: "/fake/main.js",
    webRootPath: "/fake/web-root",
    connectionsPath: "/fake/connections.json",
    secretKeyFilePath: "/fake/.env",
    windowId,
    now: () => nowMs.value
  };
}

describe("ServiceManager.acquire", () => {
  it("ロックが無ければ自分でspawnし、ロックファイルを書く", async () => {
    const lockFilePath = tempLockPath();
    const spawnServer = vi.fn(() => fakeChild(4242) as never);
    const checkHealth = vi.fn(async () => true);
    const nowMs = { value: 1_000_000 };
    const sm = new ServiceManager({ ...baseOptions(lockFilePath, "win-1", nowMs), spawnServer, checkHealth });

    const result = await sm.acquire();

    expect(spawnServer).toHaveBeenCalledTimes(1);
    expect(existsSync(lockFilePath)).toBe(true);
    const lock = JSON.parse(readFileSync(lockFilePath, "utf8")) as LockFile;
    expect(lock.pid).toBe(4242);
    expect(lock.port).toBe(result.port);
    expect(Object.keys(lock.windows)).toEqual(["win-1"]);
  });

  it("既存ロックのポートが生きていれば再利用し、spawnしない", async () => {
    const lockFilePath = tempLockPath();
    const nowMs = { value: 1_000_000 };
    const spawnServer = vi.fn(() => fakeChild(1) as never);
    const checkHealth = vi.fn(async () => true);
    const first = new ServiceManager({ ...baseOptions(lockFilePath, "win-1", nowMs), spawnServer, checkHealth });
    await first.acquire();
    spawnServer.mockClear();

    const second = new ServiceManager({ ...baseOptions(lockFilePath, "win-2", nowMs), spawnServer, checkHealth });
    const result = await second.acquire();

    expect(spawnServer).not.toHaveBeenCalled();
    const lock = JSON.parse(readFileSync(lockFilePath, "utf8")) as LockFile;
    expect(Object.keys(lock.windows).sort()).toEqual(["win-1", "win-2"]);
    expect(result.port).toBe(lock.port);
  });

  it("既存ロックのポートが死んでいれば自分で起動し直す（陳腐化ロックの上書き）", async () => {
    const lockFilePath = tempLockPath();
    const nowMs = { value: 1_000_000 };
    const deadSpawn = vi.fn(() => fakeChild(111) as never);
    const dead = new ServiceManager({
      ...baseOptions(lockFilePath, "win-dead", nowMs),
      spawnServer: deadSpawn,
      checkHealth: async () => true
    });
    await dead.acquire();

    const aliveSpawn = vi.fn(() => fakeChild(222) as never);
    const checkHealth = vi.fn(async () => false); // 既存ポートは死んでいる
    const revived = new ServiceManager({
      ...baseOptions(lockFilePath, "win-revive", nowMs),
      spawnServer: aliveSpawn,
      checkHealth
    });
    // waitUntilHealthy側のcheckHealthは新規起動確認なので、最初の呼び出しだけ既存判定に使われる
    checkHealth.mockImplementationOnce(async () => false).mockImplementation(async () => true);
    await revived.acquire();

    expect(aliveSpawn).toHaveBeenCalledTimes(1);
    const lock = JSON.parse(readFileSync(lockFilePath, "utf8")) as LockFile;
    expect(lock.pid).toBe(222);
    expect(Object.keys(lock.windows)).toEqual(["win-revive"]); // 古いwin-deadは引き継がれない（新規ロック）
  });

  it("healthzがタイムアウトし続けたら、子をkillしつつ起動失敗として例外を投げ、途中の出力もonChildOutputへ届く", async () => {
    const lockFilePath = tempLockPath();
    const nowMs = { value: 0 };
    // **`process.kill`を必ずモックする**——タイムアウト時、この工程の変更で自分が
    // spawnした（つもりの）子をkillByPidで畳むようになった。`fakeChild`のpidは
    // テスト用の適当な数値であり、モックしないと本物の`process.kill(pid, "SIGTERM")`が
    // 飛ぶ（pidの値によっては無関係な実プロセスに当たる。このコンテナでは
    // 小さいpidほど危険——PID 1はinit）
    const kill = fakeKill();
    const child = fakeChild(999999) as EventEmitter & { pid: number; stdout: EventEmitter; stderr: EventEmitter };
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    const chunks: string[] = [];
    const sm = new ServiceManager({
      ...baseOptions(lockFilePath, "win-1", nowMs),
      spawnServer: () => {
        // checkHealthの結果が出るより前（spawn直後）に出力を流す——
        // 「成否が確定する前から読める」ことを確認する
        queueMicrotask(() => child.stdout.emit("data", Buffer.from("starting\n")));
        return child as never;
      },
      checkHealth: async () => false,
      onChildOutput: (chunk) => chunks.push(chunk)
    });

    await expect(sm.acquire()).rejects.toThrow();

    expect(kill).toHaveBeenCalledWith(999999, "SIGTERM"); // 孤児化を防ぐため自分の子を畳む
    expect(chunks.some((c) => c.includes("starting"))).toBe(true); // 失敗時も出力が失われない
    kill.mockRestore();
  }, 25_000);

  it("spawn自体が失敗（errorイベント）したら、その旨を投げ子をkillしようとする", async () => {
    const lockFilePath = tempLockPath();
    const nowMs = { value: 0 };
    const kill = fakeKill();
    const child = fakeChild(777777);
    const sm = new ServiceManager({
      ...baseOptions(lockFilePath, "win-1", nowMs),
      spawnServer: () => {
        queueMicrotask(() => child.emit("error", new Error("ENOENT")));
        return child as never;
      },
      checkHealth: async () => false
    });
    await expect(sm.acquire()).rejects.toThrow(/ENOENT/);
    expect(kill).toHaveBeenCalledWith(777777, "SIGTERM");
    kill.mockRestore();
  });
});

describe("ServiceManager.release", () => {
  it("最後の参照が抜けたらkillしてロックファイルを消す", async () => {
    const lockFilePath = tempLockPath();
    const nowMs = { value: 1_000_000 };
    const kill = fakeKill();
    const sm = new ServiceManager({
      ...baseOptions(lockFilePath, "win-1", nowMs),
      spawnServer: () => fakeChild(9999) as never,
      checkHealth: async () => true
    });
    await sm.acquire();

    await sm.release();

    expect(kill).toHaveBeenCalledWith(9999, "SIGTERM");
    expect(existsSync(lockFilePath)).toBe(false);
    kill.mockRestore();
  });

  it("他のウィンドウがまだ使っていればkillせず、ロックファイルからこのwindowIdだけ外す", async () => {
    const lockFilePath = tempLockPath();
    const nowMs = { value: 1_000_000 };
    const kill = fakeKill();
    const spawnServer = () => fakeChild(12345) as never;
    const checkHealth = async () => true;
    const a = new ServiceManager({ ...baseOptions(lockFilePath, "win-a", nowMs), spawnServer, checkHealth });
    await a.acquire();
    const b = new ServiceManager({ ...baseOptions(lockFilePath, "win-b", nowMs), spawnServer, checkHealth });
    await b.acquire();

    await a.release();

    expect(kill).not.toHaveBeenCalled();
    const lock = JSON.parse(readFileSync(lockFilePath, "utf8")) as LockFile;
    expect(Object.keys(lock.windows)).toEqual(["win-b"]);
    kill.mockRestore();
  });

  it("ロックファイルが既に無ければ何もしない（二重release等で例外を出さない）", async () => {
    const lockFilePath = tempLockPath();
    const sm = new ServiceManager(baseOptions(lockFilePath, "win-1", { value: 0 }));
    await expect(sm.release()).resolves.toBeUndefined();
  });
});

describe("ServiceManager: ハートビートと陳腐化", () => {
  it("heartbeatはこのwindowIdの最終更新時刻を進める", async () => {
    const lockFilePath = tempLockPath();
    const nowMs = { value: 1_000_000 };
    const sm = new ServiceManager({
      ...baseOptions(lockFilePath, "win-1", nowMs),
      spawnServer: () => fakeChild(1) as never,
      checkHealth: async () => true
    });
    await sm.acquire();
    const before = (JSON.parse(readFileSync(lockFilePath, "utf8")) as LockFile).windows["win-1"];

    nowMs.value += 10_000;
    await sm.heartbeat();

    const after = (JSON.parse(readFileSync(lockFilePath, "utf8")) as LockFile).windows["win-1"];
    expect(Date.parse(after!)).toBeGreaterThan(Date.parse(before!));
  });

  it("90秒より古いwindowsエントリはacquire/release時に陳腐化として除かれる", async () => {
    const lockFilePath = tempLockPath();
    const nowMs = { value: 1_000_000 };
    const spawnServer = () => fakeChild(1) as never;
    const checkHealth = async () => true;
    const stale = new ServiceManager({ ...baseOptions(lockFilePath, "win-stale", nowMs), spawnServer, checkHealth });
    await stale.acquire();

    nowMs.value += 91_000; // staleを陳腐化させる
    const fresh = new ServiceManager({ ...baseOptions(lockFilePath, "win-fresh", nowMs), spawnServer, checkHealth });
    await fresh.acquire();

    const lock = JSON.parse(readFileSync(lockFilePath, "utf8")) as LockFile;
    expect(Object.keys(lock.windows)).toEqual(["win-fresh"]);
  });

  it("heartbeatはacquireしていないwindowIdでは何もしない（release後の誤生成を防ぐ）", async () => {
    const lockFilePath = tempLockPath();
    const nowMs = { value: 1_000_000 };
    // **`release()`は最後の参照が抜けると本物の`process.kill`を呼ぶ**。`fakeChild(1)`の
    // `1`はテスト用の適当な数値に過ぎないが、モックしないとこのコンテナではPID 1
    // （init）へ実際にSIGTERMを送りにいく（既存のバグ。この工程で見つけて直した）
    const kill = fakeKill();
    const spawnServer = () => fakeChild(1) as never;
    const checkHealth = async () => true;
    const sm = new ServiceManager({ ...baseOptions(lockFilePath, "win-1", nowMs), spawnServer, checkHealth });
    await sm.acquire();
    await sm.release();
    expect(existsSync(lockFilePath)).toBe(false);
    kill.mockRestore();

    await sm.heartbeat();

    expect(existsSync(lockFilePath)).toBe(false); // ハートビートだけではロックを作り直さない
  });
});
