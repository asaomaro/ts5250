// 実機のサインオン（ログイン）画面を MCP 経由で取得し、HTML に落とす。
// 資格情報を渡さず host 直接指定で開くと、自動サインオンが走らずサインオン画面のまま止まる。
import { writeFileSync } from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const OUT = process.argv[2] ?? "signon-sr.html";
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
const client = new Client({ name: "signon-html", version: "0" });
await client.connect(transport);

const call = async (name, args) => {
  const r = await client.callTool({ name, arguments: args });
  if (r.isError) throw new Error(`${name} failed: ${r.content?.[0]?.text}`);
  return r;
};

let sessionId;
try {
  const open = await call("open_session", {
    host: HOST,
    port: 23,
    ccsid: 939,
    screenSize: "27x132"
  });
  sessionId = open.structuredContent.sessionId;
  log(`open_session: ${sessionId?.slice(0, 8)}…`);

  // サインオン画面が描き切るまで待つ（日本語機なのでタイトル文字列は条件にしない）
  const w = await call("wait_screen", { sessionId, timeoutMs: 3000 });
  log(`wait_screen: timedOut=${w.structuredContent.timedOut ?? false}`);

  const scr = await call("get_screen", { sessionId, include: ["grid", "fields"] });
  log("---- screen text ----");
  log(scr.content[0].text);
  log("---------------------");
  log(`fields=${scr.structuredContent.fields?.length} cursor=(${scr.structuredContent.cursor?.row},${scr.structuredContent.cursor?.col})`);

  const html = await call("get_screen_html", {
    sessionId,
    title: "実機サインオン画面",
    // **接続先は変数から組む**（固定文字列だと別ホストで撮っても説明文が元のまま残る）
    note: `${HOST}:23 / CCSID 939 / 資格情報なしで接続（サインオン前）— MCP get_screen_html による取得`
  });
  writeFileSync(OUT, html.structuredContent.html);
  log(`wrote ${OUT} (${html.structuredContent.bytes} bytes)`);
} catch (err) {
  log("ERROR: " + err.message);
  process.exitCode = 1;
} finally {
  if (sessionId) await call("close_session", { sessionId }).catch(() => {});
  await client.close();
}
