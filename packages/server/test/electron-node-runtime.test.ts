import { it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { runInNewContext } from "node:vm";
import { once } from "node:events";
import type { ChildProcess } from "node:child_process";

/** UI を作らず、配布版のパスと外部 Node による子サーバーの寿命を実プロセスで確かめる。 */
it("Electron 内蔵ランタイムから外部 Node サーバーを起動し、アプリ終了時に片付ける", async () => {
  const dir = mkdtempSync(join(tmpdir(), "electron-node26-"));
  const root = join(dir, "app");
  const data = join(dir, "data");
  const server = join(root, "node_modules/@ts5250/server/dist");
  mkdirSync(server, { recursive: true });
  // 接続先や資格情報を使わず、実際に動いた子の Node バージョンを返す。
  writeFileSync(join(server, "main.js"), `const http=require('node:http');const p=process.argv.indexOf('--http');http.createServer((req,res)=>{res.end(JSON.stringify({node:process.versions.node}));}).listen(Number(process.argv[p+1]),'127.0.0.1');`);
  const entry = fileURLToPath(new URL("../../../electron/main.cjs", import.meta.url));
  const listeners = new Map<string, () => void>();
  const app = { isPackaged: true, getPath: () => data, requestSingleInstanceLock: () => false, quit: () => {}, on: (name: string, cb: () => void) => listeners.set(name, cb) };
  const require = createRequire(import.meta.url);
  const scope = {
    require: (name: string) => name === "electron" ? { app } : require(name),
    process: { resourcesPath: dir, platform: process.platform, env: { ...process.env, TS5250_NODE_PATH: process.execPath }, chdir: () => {}, stderr: { write: () => {} } },
    __dirname: dirname(entry), setTimeout, clearTimeout,
    launch: undefined as (() => Promise<number>) | undefined,
    child: undefined as (() => ChildProcess) | undefined
  };
  let child: ChildProcess | undefined;
  try {
    runInNewContext(readFileSync(entry, "utf8") + "\nlaunch = startServer; child = () => serverProcess;", scope);
    const port = await scope.launch!();
    child = scope.child!();
    const body = await (await fetch(`http://127.0.0.1:${port}/healthz`)).json() as { node: string };
    expect(body.node).toBe(process.versions.node);
    expect(child.spawnfile).toBe(process.execPath);
    const exited = once(child, "exit");
    listeners.get("before-quit")!();
    await exited;
    expect(child.killed).toBe(true);
  } finally {
    child?.kill();
    rmSync(dir, { recursive: true, force: true });
  }
}, 10000);
