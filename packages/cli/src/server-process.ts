/**
 * サーバーを子プロセスとして起動し、`/healthz` が通るまで待つ。
 *
 * 子プロセスにする理由: サーバーの `main.ts` は起動関数を公開しておらず、ログを stderr へ出す
 * （端末の画面と混ざる）。別プロセスなら標準エラーをファイルへ逃がせ、端末を閉じたときに確実に止められる。
 * 起動の引数・環境（`--env-file=.env`・`--profiles`）は `start.sh` と同じ決めで揃える。
 */
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, openSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

/** サーバーの実行ファイル（`@ts5250/server` の `dist/main.js`） */
export function serverMain(): string {
  return join(dirname(fileURLToPath(import.meta.resolve("@ts5250/server"))), "main.js");
}

/** `start.sh` と同じく、あるものだけを渡す（無ければ何も足さない） */
export function launchArgs(cwd: string, passthrough: readonly string[]): { node: string[]; app: string[] } {
  const node: string[] = [];
  // サーバー本体のポート指定は `--http <ポート>`。利用者には `--port` で言わせる（`start.sh` と同じ）
  const app: string[] = passthrough.map((a) => (a === "--port" ? "--http" : a));
  if (existsSync(join(cwd, ".env"))) node.push("--env-file=.env");
  if (!passthrough.includes("--profiles")) {
    if (existsSync(join(cwd, "profiles.local.json"))) app.push("--profiles", "profiles.local.json");
    else if (existsSync(join(cwd, "profiles.json"))) app.push("--profiles", "profiles.json");
  }
  return { node, app };
}

export async function healthy(port: number, host = "127.0.0.1"): Promise<boolean> {
  try {
    const r = await fetch(`http://${host}:${port}/healthz`, { signal: AbortSignal.timeout(1000) });
    return r.ok;
  } catch {
    return false;
  }
}

export interface Started {
  child: ChildProcess;
  logPath: string;
}

/** 起動して健全になるまで待つ。標準出力・標準エラーは一時ファイルへ（端末を汚さない） */
export async function startServer(port: number, passthrough: readonly string[], cwd = process.cwd()): Promise<Started> {
  const { node, app } = launchArgs(cwd, passthrough);
  const logPath = join(tmpdir(), `ts5250-server-${port}.log`);
  const fd = openSync(logPath, "a");
  const child = spawn(process.execPath, [...node, serverMain(), "--http", String(port), ...app], {
    cwd,
    stdio: ["ignore", fd, fd]
  });
  let exited: number | null | undefined;
  child.once("exit", (code) => (exited = code ?? -1));
  for (let i = 0; i < 100; i++) {
    if (exited !== undefined) throw new Error(`サーバーが起動できませんでした（終了コード ${exited}）。ログ: ${logPath}`);
    if (await healthy(port)) return { child, logPath };
    await new Promise((r) => setTimeout(r, 200));
  }
  child.kill();
  throw new Error(`サーバーの起動を待ちきれませんでした。ログ: ${logPath}`);
}
