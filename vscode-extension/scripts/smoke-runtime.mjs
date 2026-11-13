/** 同梱版だけで起動できることを、PATH を空のディレクトリへ向けて確認する（IBM i には接続しない）。 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
const ext = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const stage = process.argv[2] ? resolve(process.argv[2]) : join(ext, "server-stage");
const manifest = JSON.parse(readFileSync(join(stage, "runtime/runtime.json"), "utf8"));
if (manifest.target !== `${process.platform}-${process.arch}`) throw new Error("この実行環境と同梱 Node の対象 OS/CPU が異なります");
const nodePath = join(stage, "runtime", process.platform === "win32" ? "node.exe" : "node");
const { ServiceManager } = await import(pathToFileURL(join(ext, "dist/serviceManager.js")).href);
const data = mkdtempSync(join(tmpdir(), "ts5250-bundled-smoke-"));
const beforePath = process.env.PATH;
let manager;
try {
  process.env.PATH = data;
  const version = execFileSync(nodePath, ["--version"], { encoding: "utf8" }).trim();
  if (version !== `v${manifest.version}`) throw new Error(`同梱 Node のバージョンが一致しません: ${version}`);
  manager = new ServiceManager({
    nodePath, windowId: "bundled-smoke", lockFilePath: join(data, "service.json"),
    serverMainPath: join(stage, "node_modules/@ts5250/server/dist/main.js"),
    webRootPath: join(stage, "packages/web-ui/dist"),
    connectionsPath: join(data, "connections.json"), profilesPath: join(data, "profiles.json"),
    secretKeyFilePath: join(data, ".env"), onChildOutput: (text) => process.stderr.write(text)
  });
  const { port } = await manager.acquire();
  if (process.platform === "linux") {
    const lock = JSON.parse(readFileSync(join(data, "service.json"), "utf8"));
    if (realpathSync(`/proc/${lock.pid}/exe`) !== realpathSync(nodePath)) throw new Error("同梱版とは異なる Node で起動しました");
  }
  for (const path of ["/healthz", "/embed.html"]) {
    const response = await fetch(`http://127.0.0.1:${port}${path}`);
    if (!response.ok) throw new Error(`同梱サーバーの応答が不正です: ${path} HTTP ${response.status}`);
    await response.arrayBuffer();
  }
  process.stderr.write(`同梱 ${version} (${manifest.target}): PATH の Node なしで起動・画面配信成功\n`);
} finally {
  await manager?.release();
  if (beforePath === undefined) delete process.env.PATH;
  else process.env.PATH = beforePath;
  rmSync(data, { recursive: true, force: true });
}
