// 実機の SBCS が 1027 系（939）か 290 系（930/5026）かを、メインメニューの
// ファンクションキー行で判定する。カタカナだけ化けるのは SBCS 表の取り違えの徴候。
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const HOST = process.env.AS400_HOST;
const USER = process.env.AS400_USER;
const PASSWORD = process.env.AS400_PASSWORD;
if (!HOST || !USER || !PASSWORD) {
  process.stderr.write("AS400_HOST / AS400_USER / AS400_PASSWORD を環境変数で渡してください\n");
  process.exit(2);
}
const log = (s) => process.stderr.write(s + "\n");

const probe = async (ccsid) => {
  const transport = new StdioClientTransport({
    command: "node",
    args: ["packages/server/dist/main.js", "--stdio"],
    env: process.env
  });
  const client = new Client({ name: "probe-ccsid", version: "0" });
  await client.connect(transport);
  const call = async (name, args) => {
    const r = await client.callTool({ name, arguments: args });
    if (r.isError) throw new Error(`${name} failed: ${r.content?.[0]?.text}`);
    return r;
  };
  let sessionId;
  try {
    sessionId = (await call("open_session", { host: HOST, port: 23, ccsid }))
      .structuredContent.sessionId;
    await call("wait_screen", { sessionId, timeoutMs: 3000 });
    const f = (await call("get_screen", { sessionId, include: ["fields"] })).structuredContent.fields;
    const u = f.find((x) => !x.protected && !x.hidden);
    const p = f.find((x) => x.hidden);
    await call("send_key", {
      sessionId,
      key: "Enter",
      cursor: { row: u.row, col: u.col },
      fields: [
        { field: { row: u.row, col: u.col }, value: USER },
        { field: { row: p.row, col: p.col }, value: PASSWORD }
      ]
    });
    await call("wait_screen", { sessionId, timeoutMs: 4000 });
    await call("send_key", { sessionId, key: "Enter" }); // サインオン情報を通過
    await call("wait_screen", { sessionId, timeoutMs: 4000 });
    const scr = await call("get_screen", { sessionId, rows: { from: 1, to: 23 } });
    const rows = scr.structuredContent.text.split("\n");
    const pick = (n) => (rows.find((r) => r.startsWith(String(n).padStart(3, " ") + "|")) ?? "").slice(4).trimEnd();
    log(`--- ccsid ${ccsid} ---`);
    log(`  row 1: ${pick(1)}`);
    log(`  row22: ${pick(22)}`);
    log(`  row23: ${pick(23)}`);
    // 後始末: コマンド行から SIGNOFF
    const cf = (await call("get_screen", { sessionId, include: ["fields"] })).structuredContent.fields
      .filter((x) => !x.protected && !x.hidden).pop();
    if (cf) {
      await call("send_key", {
        sessionId, key: "Enter", cursor: { row: cf.row, col: cf.col },
        fields: [{ field: { row: cf.row, col: cf.col }, value: "SIGNOFF" }]
      });
    }
  } finally {
    if (sessionId) await call("close_session", { sessionId }).catch(() => {});
    await client.close();
  }
};

for (const c of [939, 5026]) {
  await probe(c).catch((e) => log(`ccsid ${c}: ERROR ${e.message}`));
}
