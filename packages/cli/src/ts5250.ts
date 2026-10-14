#!/usr/bin/env node
/**
 * `ts5250` — サーバーを起動し、同じ端末で 5250 の画面を開く。
 *
 *   ts5250 serve [サーバーの引数]          サーバーだけを起動（`as400-5250-server` と同じ。前面で動く）
 *   ts5250 [セッション名|srv:名|own:ID]    サーバーを起動して端末で開く（既に動いていれば再利用）
 *   ts5250 --host H [--user U --password-env 環境変数名 …]   ホストを直接指定して開く
 *
 * セッションはサーバーが持つ（ブラウザ・MCP と同じ）。画面の操作は `@ts5250/terminal` を WebSocket 越しに使う。
 */
import { spawn } from "node:child_process";
import { isDbcsCcsid } from "@ts5250/tn5250";
import { runTerminal, WsSession, PREFIX_DEFAULT } from "@ts5250/terminal";
import { parseArgs } from "./args.js";
import { healthy, launchArgs, serverMain, startServer } from "./server-process.js";

const USAGE = `使い方:
  ts5250 serve [--port N] [--profiles FILE …]   サーバーだけを起動
  ts5250 [セッション名] [--port N] [--no-spawn]  サーバーを起動して端末で開く
  ts5250 --host H [--port-host N] [--tls] [--ccsid N] [--size 24x80|27x132] [--user U --password-env 環境変数名]
  ts5250 --attach セッションID                   サーバーに既にあるセッションへ繋ぐ
  共通: --port N（サーバーの待ち受け。既定 3400）  --prefix 文字（接頭キー。既定 Ctrl+${PREFIX_DEFAULT}）
  端末の操作は ts5250-term --help を参照（矢印・Tab・F キー・Ctrl+${PREFIX_DEFAULT} の次の a/s/h/p/c/r/e/i/1-3/q）`;

/** `ts5250 serve`: 引数をそのままサーバーへ渡して前面で動かす */
function serveOnly(rest: readonly string[]): void {
  const { node, app } = launchArgs(process.cwd(), rest);
  const child = spawn(process.execPath, [...node, serverMain(), ...app], { stdio: "inherit" });
  child.on("exit", (code) => process.exit(code ?? 0));
  for (const sig of ["SIGINT", "SIGTERM"] as const) process.on(sig, () => child.kill(sig));
}

interface SessionRow {
  ref: string;
  name: string;
  sessionType: string;
}

/** 名前・参照 → 参照（`srv:`/`own:` 付きはそのまま）。曖昧・無しは例外 */
async function resolveRef(base: string, name: string | undefined): Promise<string | undefined> {
  if (name !== undefined && /^(srv|own):/.test(name)) return name;
  const r = await fetch(`${base}/api/sessions-config`);
  if (!r.ok) throw new Error(`セッション設定の一覧を取得できませんでした（HTTP ${r.status}）`);
  const rows = ((await r.json()) as { sessions?: SessionRow[] } | SessionRow[]);
  const list = (Array.isArray(rows) ? rows : (rows.sessions ?? [])).filter((x) => x.sessionType === "display");
  if (name === undefined) {
    if (list.length === 1) return list[0]!.ref;
    if (list.length === 0) throw new Error("開けるセッション設定がありません（--host で直接指定できます）");
    throw new Error(`セッションを指定してください: ${list.map((x) => x.name).join(" / ")}`);
  }
  const hit = list.filter((x) => x.name === name || x.ref.endsWith(`:${name}`));
  if (hit.length === 1) return hit[0]!.ref;
  if (hit.length === 0) throw new Error(`セッション設定が見つかりません: ${name}`);
  throw new Error(`同名のセッション設定が複数あります。参照で指定してください: ${hit.map((x) => x.ref).join(" / ")}`);
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv[0] === "--help" || argv[0] === "-h" || argv[0] === "help") {
    process.stdout.write(USAGE + "\n");
    return;
  }
  if (argv[0] === "serve") return serveOnly(argv.slice(1));

  const { positional, options } = parseArgs(argv);
  const opt = (k: string): string | undefined => {
    const v = options.get(k);
    return typeof v === "string" ? v : undefined;
  };
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    process.stderr.write("標準入出力が端末ではありません（サーバーだけなら ts5250 serve）\n");
    process.exitCode = 2;
    return;
  }
  const port = Number(opt("port") ?? 3400);
  let child: { kill: () => void } | undefined;
  if (!(await healthy(port)) || options.has("force-spawn")) {
    if (options.has("no-spawn")) throw new Error(`サーバーが ${port} 番で動いていません`);
    process.stderr.write(`サーバーを起動しています（ポート ${port}）…\n`);
    const s = await startServer(port, []);
    child = s.child;
    process.on("exit", () => s.child.kill());
  }
  const base = `http://127.0.0.1:${port}`;
  const host = opt("host");
  const attach = opt("attach");
  const ref = host || attach ? undefined : await resolveRef(base, positional[0]);
  const pwEnv = opt("password-env") ?? "AS400_PASSWORD";
  const pw = process.env[pwEnv];
  const size = opt("size");
  const ws = await WsSession.open(`ws://127.0.0.1:${port}/ws`, {
    ...(ref ? { session: ref } : {}),
    ...(attach ? { sessionId: attach } : {}),
    ...(host ? { host } : {}),
    ...(opt("port-host") ? { port: Number(opt("port-host")) } : {}),
    ...(options.has("tls") ? { tls: true } : {}),
    ...(opt("ccsid") ? { ccsid: Number(opt("ccsid")) } : {}),
    ...(size === "24x80" || size === "27x132" ? { screenSize: size } : {}),
    ...(opt("device") ? { deviceName: opt("device")! } : {}),
    ...(opt("user") ? { user: opt("user")! } : {}),
    ...(opt("user") && pw ? { password: pw } : {})
  });
  runTerminal(
    { session: ws, onScreen: (cb) => ws.onScreen(cb), onClosed: (cb) => ws.onClosed(cb) },
    { prefix: opt("prefix") ?? PREFIX_DEFAULT, sbcsOnly: !isDbcsCcsid(ws.ccsid) },
    () => child?.kill()
  );
}

main().catch((e: unknown) => {
  process.stderr.write(`${e instanceof Error ? e.message : String(e)}\n`);
  process.exitCode = 1;
});
