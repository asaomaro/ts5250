// 実機検証（tn5250）: **長さの足りないコマンドに否定応答（0x10050121）を返し、同じレコードの CC2 を効かせないか**（`20260927-short-command-sense`）。
//
// 前提: `DSCMD_LIB=<AS400_LIB> node --env-file=.env --env-file=.env.verify scripts/build-dscmd.mjs`
// （`scripts/host-src/dscmd.c` の SHORTWTD / SHORTREAD / SHORTROLL / SHORTWEC / SHORTWECW。先にメッセージ待ちを消し、1 本のレコードに WTD〔CC2＝0x01・5 行に SHORT〕＋
// 長さの足りないコマンド → 8 秒待つ → メッセージ待ちを消す）。ACS のコアの結果は `scripts/acs-probe/short-command-sense.txt`。
// **終わったら DLTPGM <AS400_LIB>/DSCMD と IFS の /tmp/dscmd.c・/tmp/dscmd.log を消す**。
//
// 実行: node --env-file=.env --env-file=.env.verify scripts/verify-short-command-sense.mjs [モード…]
import { Session5250 } from "@ts5250/tn5250";

const LIB = (process.env.AS400_LIB ?? "TESTLIB").trim().split(/\s+/)[0];
const MODES = process.argv.slice(2).length ? process.argv.slice(2) : ["SHORTWTD", "SHORTREAD", "SHORTROLL", "SHORTWEC", "SHORTWECW"];
const log = (s) => process.stderr.write(`${s}\n`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const inputs = (s) => s.snapshot().fields.filter((f) => !f.protected);
const warns = [];
let pass = 0, fail = 0;
const check = (c, m) => { if (c) { pass++; log(`  PASS ${m}`); } else { fail++; log(`  FAIL ${m}`); } };

// **モードごとに繋ぎ直す**——続けて流すと、否定応答の後の 2 本目の CALL が効かない（ACS のコアでも同じだった。ホスト側の都合）
for (const mode of MODES) {
  log(`### ${mode}`);
  const s = await Session5250.connect({ host: process.env.AS400_HOST, ccsid: 930, warn: (w) => warns.push(w) });
  // 返した否定応答を控える（0x10050121 の 4 バイトを含むレコード）
  const sent = [];
  const origSend = s.telnet.sendRecord.bind(s.telnet); // private だが測定のためだけ
  s.telnet.sendRecord = (rec) => { sent.push(Array.from(rec, (b) => b.toString(16).padStart(2, "0")).join("")); origSend(rec); };
  await sleep(1000);
  const [u, p] = inputs(s);
  s.setField({ index: u.index }, process.env.AS400_USER);
  s.setField({ index: p.index }, process.env.AS400_PASSWORD);
  await s.sendAid("Enter", { cursor: { row: u.row, col: u.col }, timeoutMs: 15000 });
  for (let i = 0; i < 4; i++) { await sleep(800); if (inputs(s).some((f) => f.length >= 50)) break; await s.sendAid("Enter", { timeoutMs: 10000 }).catch(() => {}); }
  const cmd = inputs(s).find((f) => f.length >= 50);
  s.setField({ index: cmd.index }, `CALL ${LIB}/DSCMD PARM('${mode}')`);
  const nW = warns.length, nS = sent.length;
  void s.sendAid("Enter", { cursor: { row: cmd.row, col: cmd.col }, timeoutMs: 20000 }).catch(() => {});
  await sleep(6000);
  const snap = s.snapshot();
  const row5 = snap.cells[4].map((c) => c.char).join("").trim();
  // センスは GDS のヘッダーの中（バイト境界）——偶数桁でだけ照合する（奇数桁の一致は偶然）
  const negative = sent.slice(nS).some((h) => /^(?:..)*?10050121/.test(h));
  log(`  窓の中: mw=${snap.messageWaiting === true} row5=${JSON.stringify(row5)} 否定応答 0x10050121=${negative}`);
  log(`  警告: ${JSON.stringify(warns.slice(nW))}`);
  check(row5 === "SHORT", `${mode}: 先の WTD は画面に書かれた`);
  check(negative, `${mode}: 否定応答 0x10050121 を返した`);
  check(snap.messageWaiting !== true, `${mode}: メッセージ待ちは点かない（CC2 を落とす）`);
  await sleep(9000);
  const c2 = inputs(s).find((f) => f.length >= 50);
  if (c2) { s.setField({ index: c2.index }, "SIGNOFF"); await s.sendAid("Enter", { cursor: { row: c2.row, col: c2.col }, timeoutMs: 10000 }).catch(() => {}); }
  await sleep(500);
  s.disconnect();
  await sleep(1500);
}
log(`RESULT: pass=${pass} fail=${fail}`);
process.exit(fail > 0 ? 1 : 0);
