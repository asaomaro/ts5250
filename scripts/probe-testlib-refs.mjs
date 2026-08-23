// TESTLIB の各プログラムがどの表示装置ファイル(DSPF)を使うかを DSPPGMREF で確かめる。
// 名前の規約（XXXPGM ↔ XXXDSPF）に頼らず、実機の参照情報で決める。
// 実行: node --env-file=.env --env-file=.env.verify scripts/probe-testlib-refs.mjs
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const log = (s) => process.stderr.write(s + "\n");
const transport = new StdioClientTransport({
  command: "node",
  args: ["packages/server/dist/main.js", "--stdio"],
  env: process.env
});
const client = new Client({ name: "probe-refs", version: "0" });
await client.connect(transport);
const call = async (name, args) => {
  const r = await client.callTool({ name, arguments: args });
  if (r.isError) throw new Error(`${name} failed: ${r.content?.[0]?.text}`);
  return r;
};

let sessionId;
try {
  const sys = (await call("list_systems", {})).structuredContent.systems;
  const as400 = sys.find((s) => s.name === (process.env.AS400_SYSTEM ?? "AS400"));
  sessionId = (await call("open_session", { system: as400.ref })).structuredContent.sessionId;
  await call("wait_screen", { sessionId, timeoutMs: 4000 });

  const snap = async () =>
    (await call("get_screen", { sessionId, include: ["grid", "fields"] })).structuredContent;
  const cmdField = (s) => s.fields.filter((f) => !f.protected && !f.hidden && f.length >= 40).pop();
  const isSignon = (s) => s.fields.some((f) => f.hidden) && s.fields.length >= 5;

  for (let i = 0; i < 6; i++) {
    const s = await snap();
    if (cmdField(s)) break;
    if (isSignon(s)) await call("signon", { sessionId, system: as400.ref });
    else await call("send_key", { sessionId, key: "Enter" });
    await call("wait_screen", { sessionId, timeoutMs: 5000 });
  }

  const runCmd = async (cmd) => {
    const f = cmdField(await snap());
    if (!f) throw new Error("コマンド行が無い");
    await call("send_key", {
      sessionId, key: "Enter", cursor: { row: f.row, col: f.col },
      fields: [{ field: { row: f.row, col: f.col }, value: cmd }]
    });
    await call("wait_screen", { sessionId, timeoutMs: 10000 });
  };
  const pageAll = async (max = 30) => {
    const out = [];
    for (let i = 0; i < max; i++) {
      const s = await snap();
      out.push(s.text);
      if (/終わり|Bottom/.test(s.text)) break;
      await call("send_key", { sessionId, key: "PageDown" });
      await call("wait_screen", { sessionId, timeoutMs: 8000 });
    }
    return out;
  };

  await runCmd("DSPPGMREF PGM(TESTLIB/*ALL) OUTPUT(*)");
  const pages = await pageAll();
  log("========== DSPPGMREF TESTLIB/*ALL ==========");
  for (const p of pages) log(p);
  log("============================================");

  await call("send_key", { sessionId, key: "F3" });
  await call("wait_screen", { sessionId, timeoutMs: 6000 });
  const cf = cmdField(await snap());
  if (cf) {
    await call("send_key", {
      sessionId, key: "Enter", cursor: { row: cf.row, col: cf.col },
      fields: [{ field: { row: cf.row, col: cf.col }, value: "SIGNOFF" }]
    });
  }
} catch (err) {
  log("ERROR: " + err.message);
  process.exitCode = 1;
} finally {
  if (sessionId) await call("close_session", { sessionId }).catch(() => {});
  await client.close();
}
