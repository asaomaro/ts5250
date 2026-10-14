#!/usr/bin/env node
/**
 * `ts5250ctl` — 動いているサーバーの MCP ツールを、コマンドラインから実行する。
 *
 *   ts5250ctl list                      ツール一覧
 *   ts5250ctl describe <ツール名>        引数の仕様（入力スキーマ）
 *   ts5250ctl <ツール名> --引数 値 …     実行。`--json '{...}'` でまとめて渡せる
 *
 * 接続先は `--url`（既定 `$TS5250_URL`、無ければ `http://127.0.0.1:3400/mcp`）。ツールの一覧・引数はサーバーが
 * 返すものをそのまま使うので、ツールが増えてもここは変わらない。結果は標準出力、エラーは標準エラー・終了コード 1。
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { buildToolArgs, parseArgs, type PropSchema } from "./args.js";

const USAGE = `使い方:
  ts5250ctl list [--url URL]
  ts5250ctl describe <ツール名>
  ts5250ctl <ツール名> [--引数 値 …] [--json '{"引数":値}']
  接続先: --url（既定 $TS5250_URL、無ければ http://127.0.0.1:3400/mcp）
  値の型はツールの入力スキーマで決まる（数・真偽は自動変換。配列・オブジェクトは JSON で渡す）`;

interface ToolInfo {
  name: string;
  description?: string;
  inputSchema?: { properties?: Record<string, PropSchema & { description?: string }>; required?: string[] };
}

/** 一覧用の 1 文目（長い説明を端末の 1 行に収める） */
function firstSentence(d: string | undefined): string {
  const line = (d ?? "").split("\n")[0] ?? "";
  const i = line.indexOf("。");
  return i >= 0 ? line.slice(0, i + 1) : line;
}

function print(s: string): void {
  process.stdout.write(s.endsWith("\n") ? s : s + "\n");
}

/** ツールの結果（content 配列）を人が読める形で出す。JSON の文字列は整形する */
function show(content: unknown[]): void {
  for (const c of content) {
    const item = c as { type?: string; text?: string; mimeType?: string; data?: string };
    if (item.type === "text" && item.text !== undefined) {
      try {
        print(JSON.stringify(JSON.parse(item.text), null, 2));
      } catch {
        print(item.text);
      }
    } else if (item.type === "image") print(`[画像 ${item.mimeType ?? ""} ${item.data?.length ?? 0} バイト（base64）]`);
    else print(JSON.stringify(c));
  }
}

async function main(): Promise<void> {
  // `| head` などで読み手が先に閉じても静かに終わる
  process.stdout.on("error", (e: NodeJS.ErrnoException) => {
    if (e.code === "EPIPE") process.exit(0);
    throw e;
  });
  const { positional, options } = parseArgs(process.argv.slice(2));
  const cmd = positional[0];
  if (cmd === undefined || cmd === "help" || options.has("help") || options.has("h")) {
    print(USAGE);
    return;
  }
  const urlOpt = options.get("url");
  const url = typeof urlOpt === "string" ? urlOpt : (process.env["TS5250_URL"] ?? "http://127.0.0.1:3400/mcp");
  const client = new Client({ name: "ts5250ctl", version: "0.1.0" });
  try {
    // exactOptionalPropertyTypes の下では sdk の型が合わない（実体は Transport）
    await client.connect(new StreamableHTTPClientTransport(new URL(url)) as unknown as Transport);
  } catch (e) {
    throw new Error(`サーバーに繋げません（${url}）。ts5250 serve で起動してください: ${e instanceof Error ? e.message : String(e)}`);
  }
  try {
    const tools = ((await client.listTools()).tools as ToolInfo[]) ?? [];
    if (cmd === "list") {
      for (const t of tools) print(`${t.name}\t${firstSentence(t.description)}`);
      return;
    }
    if (cmd === "describe") {
      const t = tools.find((x) => x.name === positional[1]);
      if (!t) throw new Error(`ツールが見つかりません: ${positional[1] ?? ""}`);
      print(`${t.name}\n${t.description ?? ""}\n`);
      const req = new Set(t.inputSchema?.required ?? []);
      for (const [k, p] of Object.entries(t.inputSchema?.properties ?? {})) {
        const ty = Array.isArray(p.type) ? p.type.join("|") : (p.type ?? "");
        print(`  --${k} <${ty}>${req.has(k) ? " (必須)" : ""}  ${(p.description ?? "").split("\n")[0]}`);
      }
      return;
    }
    const tool = tools.find((x) => x.name === cmd);
    if (!tool) throw new Error(`ツールが見つかりません: ${cmd}（ts5250ctl list で一覧）`);
    const args = buildToolArgs(options, tool.inputSchema?.properties);
    const res = await client.callTool({ name: cmd, arguments: args });
    show((res.content as unknown[]) ?? []);
    if (res.isError) process.exitCode = 1;
  } finally {
    await client.close();
  }
}

main().catch((e: unknown) => {
  process.stderr.write(`${e instanceof Error ? e.message : String(e)}\n`);
  process.exitCode = 1;
});
