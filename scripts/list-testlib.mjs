// 修正後の connections.json で実機へ再接続し、TESTLIB の中身を一覧する。
// 実行: node --env-file=.env scripts/list-testlib.mjs
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const log = (s) => process.stderr.write(s + "\n");
const transport = new StdioClientTransport({
  command: "node",
  args: ["packages/server/dist/main.js", "--stdio"],
  env: process.env
});
const client = new Client({ name: "list-testlib", version: "0" });
await client.connect(transport);
const call = async (name, args) => {
  const r = await client.callTool({ name, arguments: args });
  if (r.isError) throw new Error(`${name} failed: ${r.content?.[0]?.text}`);
  return r;
};

let sessionId;
try {
  const sys = (await call("list_systems", {})).structuredContent.systems;
  log("systems: " + sys.map((s) => `${s.ref}(${s.name}, autoSignon=${s.autoSignon})`).join(", "));
  const as400 = sys.find((s) => s.name === (process.env.AS400_SYSTEM ?? "AS400"));
  if (!as400) throw new Error("実機が見つからない");

  // system 参照で開く（装置名はホスト採番。保存済みの資格情報で自動サインオン）
  sessionId = (await call("open_session", { system: as400.ref })).structuredContent.sessionId;
  await call("wait_screen", { sessionId, timeoutMs: 4000 });
  log(`open_session: ${sessionId.slice(0, 8)}…`);

  const snap = async () =>
    (await call("get_screen", { sessionId, include: ["grid", "fields"] })).structuredContent;
  // コマンド行は「長い」入力欄。サインオン画面の 10 桁欄と取り違えないため長さで見分ける
  const cmdField = (s) => s.fields.filter((f) => !f.protected && !f.hidden && f.length >= 40).pop();
  const isSignon = (s) => s.fields.some((f) => f.hidden) && s.fields.length >= 5;

  // サインオン画面なら保存済み資格情報で画面入力サインオン、通過画面は実行キーで抜ける
  for (let i = 0; i < 6; i++) {
    const s = await snap();
    if (cmdField(s)) break;
    if (isSignon(s)) {
      log("自動サインオンが効いていない → signon ツールでフォールバック");
      await call("signon", { sessionId, system: as400.ref });
    } else {
      await call("send_key", { sessionId, key: "Enter" });
    }
    await call("wait_screen", { sessionId, timeoutMs: 5000 });
  }
  const menu = await snap();
  log("着地画面:\n" + menu.text.split("\n").slice(0, 4).join("\n"));

  // コマンド行から DSPLIB。1 画面ずつ読んで「終わり」まで PageDown
  const runCmd = async (cmd) => {
    const s = await snap();
    const f = cmdField(s);
    if (!f) throw new Error("コマンド行が無い");
    await call("send_key", {
      sessionId, key: "Enter", cursor: { row: f.row, col: f.col },
      fields: [{ field: { row: f.row, col: f.col }, value: cmd }]
    });
    await call("wait_screen", { sessionId, timeoutMs: 8000 });
  };

  await runCmd("DSPLIB LIB(TESTLIB) OUTPUT(*)");
  const pages = [];
  for (let i = 0; i < 12; i++) {
    const s = await snap();
    pages.push(s.text);
    if (/終わり|Bottom/.test(s.text)) break;
    await call("send_key", { sessionId, key: "PageDown" });
    await call("wait_screen", { sessionId, timeoutMs: 6000 });
  }
  log("========== DSPLIB TESTLIB ==========");
  for (const p of pages) log(p);
  log("====================================");

  await call("send_key", { sessionId, key: "F3" }); // 一覧を閉じる
  await call("wait_screen", { sessionId, timeoutMs: 6000 });
  const back = await snap();
  const cf = cmdField(back);
  if (cf) {
    await call("send_key", {
      sessionId, key: "Enter", cursor: { row: cf.row, col: cf.col },
      fields: [{ field: { row: cf.row, col: cf.col }, value: "SIGNOFF" }]
    });
    log("signoff: 送信");
  }
} catch (err) {
  log("ERROR: " + err.message);
  process.exitCode = 1;
} finally {
  if (sessionId) await call("close_session", { sessionId }).catch(() => {});
  await client.close();
}
