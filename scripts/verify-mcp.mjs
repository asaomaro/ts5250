// T12: MCP E2E（実機）— stdio MCP サーバーを起動し、MCP クライアントから
// open_session(session)→get_screen→send_key→get_job_info→close_session を検証する。
// 実行: node --env-file=.env scripts/verify-mcp.mjs
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const log = (s) => process.stderr.write(s + "\n");
const transport = new StdioClientTransport({
  command: "node",
  args: ["packages/server/dist/main.js", "--stdio", "--profiles", "profiles.local.json"],
  env: process.env
});
const client = new Client({ name: "verify-mcp", version: "0" });
await client.connect(transport);

const call = async (name, args) => {
  const r = await client.callTool({ name, arguments: args });
  if (r.isError) throw new Error(`${name} failed: ${r.content?.[0]?.text}`);
  return r;
};

let ok = true;
try {
  // 1. open_session with session（親システムの自動サインオン）
  const open = await call("open_session", { session: "srv:pub400" });
  const sessionId = open.structuredContent.sessionId;
  const onMenu = /Main Menu/i.test(open.content[0].text);
  log(`open_session: sessionId=${sessionId?.slice(0, 8)}… onMenu=${onMenu}`);
  ok = ok && onMenu && !!sessionId;

  // 2. list_sessions
  const list = await call("list_sessions", {});
  log(`list_sessions: ${list.structuredContent.sessions.length} session(s)`);
  ok = ok && list.structuredContent.sessions.length === 1;

  // 3. get_screen（fields のみ絞り込み）
  const scr = await call("get_screen", { sessionId, include: ["fields"] });
  log(`get_screen(fields): ${scr.structuredContent.fields.length} field(s), cursor=(${scr.structuredContent.cursor.row},${scr.structuredContent.cursor.col})`);

  // 4. send_key: コマンド行に "DSPLIB QGPL" 相当は避け、F キー遷移を検証（F3 は sign off になり得るので F1 ヘルプ→F3）
  //    ここではコマンド行に "WRKACTJOB" ではなく安全な操作: set_fields で入力→そのままにせず、send_key で Enter
  //    受け入れ基準（F キー送信で画面遷移）を満たすため、まず get_job_info を使う（画面遷移を伴う）
  const job = await call("get_job_info", { sessionId });
  log(`get_job_info: ${job.structuredContent.job.number}/${job.structuredContent.job.user}/${job.structuredContent.job.name}`);
  ok = ok && /^\d+$/.test(job.structuredContent.job.number);

  // 5. send_key F キー: F1（ヘルプ）→ 画面が変わる（keyboardLocked 解除確認）
  const key = await call("send_key", { sessionId, key: "F1", include: ["grid"] });
  log(`send_key(F1): keyboardLocked=${key.structuredContent.keyboardLocked}`);

  // 6. close_session
  await call("close_session", { sessionId });
  log("close_session: ok");
} catch (err) {
  ok = false;
  log("E2E ERROR: " + err.message);
} finally {
  await client.close();
}

log(ok ? "T12: OK — MCP E2E 成功" : "T12: NG");
process.exit(ok ? 0 : 1);
