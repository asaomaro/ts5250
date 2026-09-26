// 実機検証（tn5250）: **WRITE ERROR CODE TO WINDOW（0x22）のメッセージを ACS と同じ行・桁に置くか**（`20260926-window-error-code`）。
//
// 前提: `DSCMD_LIB=<AS400_LIB> node --env-file=.env --env-file=.env.verify scripts/build-dscmd.mjs`
// （`scripts/host-src/dscmd.c` の WINERR / WINERRLONG / WINERR22 / WINERR22LONG。窓を開いて 0x22〔開始桁 12・終了桁 29〕を撃ち READ MDT で止まる）。
// ACS のコアの結果は `scripts/acs-probe/window-error-code.txt`（最下行は ACS が開始桁を捨てて行頭から書く・22 行は開始桁どおり・本文は 18 バイトで切れる）。
// **終わったら DLTPGM <AS400_LIB>/DSCMD と IFS の /tmp/dscmd.c・/tmp/dscmd.log を消す**。
//
// 実行: node --env-file=.env --env-file=.env.verify scripts/verify-window-error-code.mjs
import { Session5250 } from "@ts5250/tn5250";

const LIB = (process.env.AS400_LIB ?? "TESTLIB").trim().split(/\s+/)[0];
const log = (s) => process.stderr.write(`${s}\n`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const inputs = (s) => s.snapshot().fields.filter((f) => !f.protected);
let pass = 0, fail = 0;
const check = (c, m) => { if (c) { pass++; log(`  PASS ${m}`); } else { fail++; log(`  FAIL ${m}`); } };

// [モード, ACS の行, ACS の書き始めの桁（属性の桁）, ACS に出た本文]
const CASES = [
  ["WINERR", 24, 1, "ERR IN WINDOW"],
  ["WINERRLONG", 24, 1, "ABCDEFGHIJKLMNOPQ"],
  ["WINERR22", 22, 12, "ERR IN WINDOW"],
  ["WINERR22LONG", 22, 12, "ABCDEFGHIJKLMNOPQ"]
];

const s = await Session5250.connect({ host: process.env.AS400_HOST, ccsid: 930 });
await sleep(1000);
const [u, p] = inputs(s);
s.setField({ index: u.index }, process.env.AS400_USER);
s.setField({ index: p.index }, process.env.AS400_PASSWORD);
await s.sendAid("Enter", { cursor: { row: u.row, col: u.col }, timeoutMs: 15000 });
for (let i = 0; i < 4; i++) { await sleep(800); if (inputs(s).some((f) => f.length >= 50)) break; await s.sendAid("Enter", { timeoutMs: 10000 }).catch(() => {}); }
for (const [mode, row, col, text] of CASES) {
  const cmd = inputs(s).find((f) => f.length >= 50);
  s.setField({ index: cmd.index }, `CALL ${LIB}/DSCMD PARM('${mode}')`);
  void s.sendAid("Enter", { cursor: { row: cmd.row, col: cmd.col }, timeoutMs: 20000 }).catch(() => {});
  await sleep(3000);
  const snap = s.snapshot();
  log(`${mode}: systemMessage=${JSON.stringify(snap.systemMessage)} area=${JSON.stringify(snap.systemMessageArea)}`);
  check(snap.systemMessage === text, `${mode}: 本文が ACS と同じ（${text}）`);
  check(snap.systemMessageArea?.row === row && snap.systemMessageArea?.col === col, `${mode}: 行 ${row}・桁 ${col} から（ACS と同じ）`);
  // 次へ: Enter で READ MDT を返し、コマンド行へ戻る
  await s.sendAid("Enter", { timeoutMs: 10000 }).catch(() => {});
  await sleep(1500);
}
const c2 = inputs(s).find((f) => f.length >= 50);
if (c2) { s.setField({ index: c2.index }, "SIGNOFF"); await s.sendAid("Enter", { cursor: { row: c2.row, col: c2.col }, timeoutMs: 10000 }).catch(() => {}); }
await sleep(500);
s.disconnect();
log(`RESULT: pass=${pass} fail=${fail}`);
process.exit(fail > 0 ? 1 : 0);
