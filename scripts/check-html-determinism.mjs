// get_screen_html が決定的か（同じ画面から常に同じ HTML か）を実機で確かめる。
// 同一セッションで 2 回叩き、capturedAt 行だけ除いて比較する。
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const HOST = process.env.AS400_HOST;
if (!HOST) {
  process.stderr.write("AS400_HOST を環境変数で渡してください\n");
  process.exit(2);
}
const log = (s) => process.stderr.write(s + "\n");
const transport = new StdioClientTransport({
  command: "node",
  args: ["packages/server/dist/main.js", "--stdio"],
  env: process.env
});
const client = new Client({ name: "check-determinism", version: "0" });
await client.connect(transport);
const call = async (name, args) => {
  const r = await client.callTool({ name, arguments: args });
  if (r.isError) throw new Error(`${name} failed: ${r.content?.[0]?.text}`);
  return r;
};

let sessionId;
try {
  const open = await call("open_session", { host: HOST, port: 23, ccsid: 939 });
  sessionId = open.structuredContent.sessionId;
  await call("wait_screen", { sessionId, timeoutMs: 3000 });

  const a = (await call("get_screen_html", { sessionId, title: "T", note: "N" })).structuredContent.html;
  const b = (await call("get_screen_html", { sessionId, title: "T", note: "N" })).structuredContent.html;
  const strip = (s) => s.replace(/<dt>取得日時<\/dt><dd>[^<]*<\/dd>/, "").replace(/<dd>[0-9a-f-]{36}<\/dd>/, "");
  log(`raw identical      : ${a === b}`);
  log(`capturedAt/セッションID を除いて identical: ${strip(a) === strip(b)}`);
  log(`bytes: ${a.length} / ${b.length}`);
} catch (err) {
  log("ERROR: " + err.message);
  process.exitCode = 1;
} finally {
  if (sessionId) await call("close_session", { sessionId }).catch(() => {});
  await client.close();
}
