// TESTLIB の画面プログラムを順に CALL し、遷移する画面をまとめて HTML にする。
// プログラム 1 本につき HTML 1 枚（前後にたどれる履歴版）。
//
// 対象は DSPPGMREF で「表示装置ファイルを参照する」と分かったものだけ
// （scripts/probe-testlib-refs.mjs の結果）。
//
// 実行: node --env-file=.env --env-file=.env.verify scripts/shot-testlib-screens.mjs <出力ディレクトリ>
import { mkdirSync, writeFileSync } from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const OUTDIR = process.argv[2] ?? "testlib-screens";
mkdirSync(OUTDIR, { recursive: true });

const LIB = process.env.AS400_LIB ?? "TESTLIB";
/**
 * AS400_CCSID を与えると host 直指定＋その CCSID で開く（比較用）。
 * 未指定なら connections.json の保存値（＝実機に合わせた 5026）を使う。
 */
const CCSID_OVERRIDE = process.env.AS400_CCSID ? Number(process.env.AS400_CCSID) : undefined;
/**
 * host 直指定は **CCSID を上書きするときだけ**要る。既定は connections.json の
 * 保存値（`実機`）で開くので、AS400_HOST を必須にすると既定の使い方が壊れる。
 */
const HOST = process.env.AS400_HOST;
if (CCSID_OVERRIDE && !HOST) {
  process.stderr.write("AS400_CCSID を指定するときは AS400_HOST も渡してください\n");
  process.exit(2);
}
/** プログラム → 使う表示装置ファイル（実機の DSPPGMREF から） */
const PROGRAMS = [
  ["ADJPGM", "ADJDSPF"], ["DTMPGM", "DTMDSPF"], ["EDTPGM", "EDTDSPF"],
  ["EMPSFR", "EMPDSPF"], ["EXTPGM", "EXTDSPF"], ["FEATPGM", "FEATDSPF"],
  ["FFWPGM", "FFWDSPF"], ["OPTPGM", "OPTDSPF"], ["SGNPGM", "SGNDSPF"],
  ["GRIDCL", "GRIDTEST"], ["GRIDCL2", "GRIDTST2"], ["GRIDCL3", "GRIDTST3"],
  ["GRIDCL4", "GRIDTST3"], ["GRIDCL5", "GRIDTST3"], ["GRIDCL6", "GRIDTST4"],
  ["GRIDCL7", "GRIDTST5"]
];
/** 1 プログラムあたり進める最大回数（無限ループの画面で止まらなくなるのを防ぐ） */
const MAX_ADVANCE = 10;

const log = (s) => process.stderr.write(s + "\n");
const transport = new StdioClientTransport({
  command: "node",
  args: ["packages/server/dist/main.js", "--stdio"],
  env: process.env
});
const client = new Client({ name: "shot-testlib", version: "0" });
await client.connect(transport);
const call = async (name, args) => {
  const r = await client.callTool({ name, arguments: args });
  if (r.isError) throw new Error(`${name} failed: ${r.content?.[0]?.text}`);
  return r;
};

let sysRef;
let sessionId;

const snap = async () =>
  (await call("get_screen", { sessionId, include: ["grid", "fields"] })).structuredContent;
const cmdField = (s) => s.fields.filter((f) => !f.protected && !f.hidden && f.length >= 40).pop();
const isSignon = (s) => s.fields.some((f) => f.hidden) && s.fields.length >= 5;
const row1 = (s) => (s.text.split("\n")[1] ?? "").slice(4).trim();
/** MAIN メニューに戻っているか。プログラムの画面と取り違えないよう行 1 の見出しで見る */
const atMenu = (s) => row1(s).startsWith("MAIN") && Boolean(cmdField(s));
const nospc = (t) => t.replace(/\s+/g, "");
/** 照会メッセージ画面（CALL が失敗すると出る）。応答待ちなので放置しない */
const isMsgScreen = (s) => nospc(row1(s)).includes("プログラム・メッセージの表示");
/** 照会に C（取り消し）で答えて畳む */
async function answerInquiry() {
  const s = await snap();
  if (!isMsgScreen(s)) return false;
  const f = s.fields.find((x) => !x.protected && !x.hidden);
  if (f) {
    await call("send_key", {
      sessionId, key: "Enter", cursor: { row: f.row, col: f.col },
      fields: [{ field: { row: f.row, col: f.col }, value: "C" }]
    }).catch(() => {});
    await call("wait_screen", { sessionId, timeoutMs: 6000 }).catch(() => {});
  }
  return true;
}

/** 接続して MAIN メニューまで進める。既存セッションがあれば畳んでから */
async function connect() {
  if (sessionId) await call("close_session", { sessionId }).catch(() => {});
  sessionId = (
    await call(
      "open_session",
      CCSID_OVERRIDE ? { host: HOST, port: 23, ccsid: CCSID_OVERRIDE } : { system: sysRef }
    )
  ).structuredContent.sessionId;
  await call("wait_screen", { sessionId, timeoutMs: 5000 });
  for (let i = 0; i < 6; i++) {
    const s = await snap();
    if (atMenu(s)) break;
    if (isSignon(s)) await call("signon", { sessionId, system: sysRef });
    else await call("send_key", { sessionId, key: "Enter" });
    await call("wait_screen", { sessionId, timeoutMs: 5000 });
  }
  if (!atMenu(await snap())) throw new Error("MAIN メニューに着けない");
  // **ライブラリー・リストに TESTLIB が要る。** 修飾名で CALL しても、プログラムが
  // 開く表示装置ファイルは非修飾なので *LIBL から探され、無いと CPF4101 で落ちる
  await runCmd(`ADDLIBLE LIB(${LIB})`);
  if (isMsgScreen(await snap())) await answerInquiry();
}

const runCmd = async (cmd, timeoutMs = 15000) => {
  const f = cmdField(await snap());
  if (!f) throw new Error("コマンド行が無い");
  await call("send_key", {
    sessionId, key: "Enter", cursor: { row: f.row, col: f.col },
    fields: [{ field: { row: f.row, col: f.col }, value: cmd }]
  });
  await call("wait_screen", { sessionId, timeoutMs });
};

/** メニューへ戻す。F3 → F12 の順で試し、駄目なら繋ぎ直す */
async function backToMenu() {
  for (const key of ["F3", "F12", "F3", "F12"]) {
    if (atMenu(await snap())) return true;
    if (await answerInquiry()) continue;
    await call("send_key", { sessionId, key }).catch(() => {});
    await call("wait_screen", { sessionId, timeoutMs: 6000 }).catch(() => {});
  }
  if (atMenu(await snap())) return true;
  log("  … メニューに戻れないので繋ぎ直す");
  await connect();
  return false;
}

const summary = [];
try {
  const sys = (await call("list_systems", {})).structuredContent.systems;
  sysRef = sys.find((s) => s.name === (process.env.AS400_SYSTEM ?? "AS400"))?.ref;
  if (!sysRef) throw new Error("実機が見つからない");
  await connect();
  log(`接続: ${sessionId.slice(0, 8)}… / MAIN メニュー`);

  for (const [pgm, dspf] of PROGRAMS) {
    log(`--- ${pgm} (${dspf}) ---`);
    try {
      if (isMsgScreen(await snap())) await answerInquiry();
      if (!atMenu(await snap())) await backToMenu();
      await runCmd(`CALL ${LIB}/${pgm}`);

      let first = await snap();
      if (isMsgScreen(first)) {
        const msg = first.text.split("\n").slice(3, 8).join(" ").replace(/\s+/g, " ").trim();
        log(`  CALL 失敗: ${msg.slice(0, 110)}`);
        summary.push({ pgm, dspf, frames: 0, note: "CALL が失敗（照会メッセージ）", msg });
        await answerInquiry();
        await backToMenu();
        continue;
      }
      if (atMenu(first)) {
        // 画面が出ないまま戻った＝CALL が失敗している。メニュー下部のメッセージを残す
        const msg = first.text.split("\n").slice(-3).join(" ").replace(/\s+/g, " ").trim();
        log(`  画面が出ない: ${msg.slice(0, 100)}`);
        summary.push({ pgm, dspf, frames: 0, note: "CALL しても画面が出ない", msg });
        continue;
      }

      // 記録開始（開始時点＝プログラムの最初の画面が 1 コマ目）
      await call("start_screen_recording", { sessionId, limit: 40 });
      let advanced = 0;
      for (let i = 0; i < MAX_ADVANCE; i++) {
        const s = await snap();
        if (atMenu(s)) break;
        if (isMsgScreen(s)) break; // 途中でエラー照会に落ちたら、そこまでを記録して抜ける
        await call("send_key", { sessionId, key: "Enter" });
        await call("wait_screen", { sessionId, timeoutMs: 8000 }).catch(() => {});
        advanced++;
        const after = await snap();
        // 画面が変わらなくなったら、その先は同じ絵の繰り返しなので打ち切る
        if (after.text === s.text) break;
      }
      const stopped = await call("stop_screen_recording", { sessionId });
      const frames = stopped.structuredContent.frames;

      const html = await call("get_screen_history_html", {
        sessionId,
        title: `${LIB}/${pgm} — ${dspf} の表示`,
        // 接続先は**分かっているときだけ**書く。保存値で開いた回に固定文字列を出すと、
        // どのホストを撮ったのか説明文が保証できなくなる
        note: `実機${HOST ? `(${HOST})` : ""} / CCSID ${CCSID_OVERRIDE ?? 5026} / CALL ${LIB}/${pgm} — 実行キーで送り、遷移した画面をすべて収録`,
        clear: true
      });
      const file = `${OUTDIR}/testlib-${pgm}.html`;
      writeFileSync(file, html.structuredContent.html);
      log(`  frames=${frames} advance=${advanced} → ${file} (${html.structuredContent.bytes} bytes)`);
      summary.push({ pgm, dspf, frames, file });

      await backToMenu();
    } catch (err) {
      log(`  ERROR ${pgm}: ${err.message}`);
      summary.push({ pgm, dspf, frames: 0, note: "エラー", msg: err.message });
      await connect().catch(() => {});
    }
  }

  // 後始末
  if (atMenu(await snap().catch(() => ({ text: "", fields: [] })))) {
    const f = cmdField(await snap());
    if (f) await call("send_key", {
      sessionId, key: "Enter", cursor: { row: f.row, col: f.col },
      fields: [{ field: { row: f.row, col: f.col }, value: "SIGNOFF" }]
    }).catch(() => {});
  }
} catch (err) {
  log("ERROR: " + err.message);
  process.exitCode = 1;
} finally {
  if (sessionId) await call("close_session", { sessionId }).catch(() => {});
  await client.close();
}

log("\n===== まとめ =====");
for (const s of summary) {
  log(`${s.pgm.padEnd(8)} ${String(s.dspf).padEnd(9)} frames=${String(s.frames).padStart(2)} ${s.note ?? ""} ${s.msg ?? ""}`.trimEnd());
}
writeFileSync(`${OUTDIR}/summary.json`, JSON.stringify(summary, null, 2));
