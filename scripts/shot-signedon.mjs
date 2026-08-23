// 実機にサインオンし、認証後の画面を MCP 経由で HTML に落とす。
//
// 資格情報はこのファイルに書かない。実行時に環境変数で渡す:
//   AS400_USER=... AS400_PASSWORD=... node --env-file=.env --env-file=.env.verify scripts/shot-signedon.mjs out.html
//
// 装置名はホスト採番に任せる（固定装置名を使い回すと前ジョブの回復画面に当たる）。
import { writeFileSync } from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const OUT = process.argv[2] ?? "signedon-sr.html";
const HOST = process.env.AS400_HOST;
const USER = process.env.AS400_USER;
const PASSWORD = process.env.AS400_PASSWORD;
// 実機の SBCS はカタカナ側（290）。939 で繋ぐと F キー行のカタカナが英小文字に化ける
// （scripts/probe-ccsid.mjs で実測）
const CCSID = Number(process.env.AS400_CCSID ?? 5026);
if (!HOST || !USER || !PASSWORD) {
  process.stderr.write("AS400_HOST / AS400_USER / AS400_PASSWORD を環境変数で渡してください\n");
  process.exit(2);
}

const log = (s) => process.stderr.write(s + "\n");
const transport = new StdioClientTransport({
  command: "node",
  args: ["packages/server/dist/main.js", "--stdio"],
  env: process.env
});
const client = new Client({ name: "signedon-html", version: "0" });
await client.connect(transport);

const call = async (name, args) => {
  const r = await client.callTool({ name, arguments: args });
  if (r.isError) throw new Error(`${name} failed: ${r.content?.[0]?.text}`);
  return r;
};
const screenText = async (sessionId) =>
  (await call("get_screen", { sessionId })).structuredContent.text;

let sessionId;
try {
  const open = await call("open_session", { host: HOST, port: 23, ccsid: CCSID });
  sessionId = open.structuredContent.sessionId;
  await call("wait_screen", { sessionId, timeoutMs: 3000 });
  log(`open_session: ${sessionId?.slice(0, 8)}…`);

  // サインオン画面のフィールド構成を確かめてから入れる（座標を決め打ちしない）
  const before = await call("get_screen", { sessionId, include: ["fields"] });
  const flds = before.structuredContent.fields;
  const userFld = flds.find((f) => !f.protected && !f.hidden);
  const pwFld = flds.find((f) => f.hidden);
  if (!userFld || !pwFld) throw new Error(`サインオン画面ではない（fields=${flds.length}）`);
  log(`user=(${userFld.row},${userFld.col}) password=(${pwFld.row},${pwFld.col}) hidden=${pwFld.hidden}`);
  const beforeText = before.structuredContent.text;

  // ユーザー／パスワードを載せて Enter。sendAid は新画面の到着を待たないので、後で待つ
  await call("send_key", {
    sessionId,
    key: "Enter",
    cursor: { row: userFld.row, col: userFld.col },
    fields: [
      { field: { row: userFld.row, col: userFld.col }, value: USER },
      { field: { row: pwFld.row, col: pwFld.col }, value: PASSWORD }
    ]
  });

  // 画面が入れ替わるまで待つ（何度かホスト発の更新が来る）
  let text = await screenText(sessionId);
  for (let i = 0; i < 5 && text === beforeText; i++) {
    await call("wait_screen", { sessionId, timeoutMs: 4000 });
    text = await screenText(sessionId);
  }
  log("---- screen after signon ----");
  log(text);
  log("-----------------------------");

  const job = await call("get_job_info", { sessionId }).catch(() => null);
  if (job) log(`job: ${JSON.stringify(job.structuredContent.job)}`);

  const shot = async (file, title, note) => {
    const html = await call("get_screen_html", { sessionId, title, note });
    writeFileSync(file, html.structuredContent.html);
    log(`wrote ${file} (${html.structuredContent.bytes} bytes)`);
  };
  // **接続先は変数から組む**。固定文字列にすると、別ホストへ繋いだのに
  // 成果物の説明文だけ元のホストのまま残る（動作に出ないので気づけない）
  const meta = `${HOST}:23 / CCSID ${CCSID} / ユーザー ${USER} でサインオン — MCP get_screen_html による取得`;
  await shot(`${OUT}-01-signon-info.html`, "実機認証直後（サインオン情報）", meta);

  // サインオン情報は通過画面。実行キーで先へ進み、着地した画面（メニュー）を撮る
  const infoText = text;
  await call("send_key", { sessionId, key: "Enter" });
  text = await screenText(sessionId);
  for (let i = 0; i < 5 && text === infoText; i++) {
    await call("wait_screen", { sessionId, timeoutMs: 4000 });
    text = await screenText(sessionId);
  }
  log("---- screen after Enter ----");
  log(text);
  log("----------------------------");
  await shot(`${OUT}-02-menu.html`, "実機認証後の画面（メニュー）", meta);

  // 後始末: コマンド行から SIGNOFF（ジョブを残さない）。失敗しても撮影結果は捨てない
  try {
    const cur = await call("get_screen", { sessionId, include: ["fields"] });
    const cmd = cur.structuredContent.fields.filter((f) => !f.protected && !f.hidden).pop();
    if (cmd) {
      await call("send_key", {
        sessionId,
        key: "Enter",
        cursor: { row: cmd.row, col: cmd.col },
        fields: [{ field: { row: cmd.row, col: cmd.col }, value: "SIGNOFF" }]
      });
      log("signoff: 送信");
    }
  } catch (e) {
    log("signoff: 見送り — " + e.message);
  }
} catch (err) {
  log("ERROR: " + err.message);
  process.exitCode = 1;
} finally {
  if (sessionId) await call("close_session", { sessionId }).catch(() => {});
  await client.close();
}
