// 実機検証（tn5250）: **WRITE ERROR CODE TO WINDOW（0x22）のメッセージを ACS と同じ行・桁に置くか**（`20260926-window-error-code`）。
// **WRITE ERROR CODE（0x21）を SOH が申告したメッセージ行に置くか**も同じ流れで測る（`20260926-wec-msgline-row`。WEC / WEC22 / WEC22LONG。
// ACS のコアの結果は `scripts/acs-probe/wec-msgline-row.txt`——申告なしは 24 行・22 を申告すれば 22 行、どちらも 1 行全体。90 字の続きを 23 行へ
// 上書きする ACS の挙動は情報を捨てるので合わせない＝当 PJ は 22 行の 1 行だけ〔decisions D2〕）。
//
// 前提: `DSCMD_LIB=<AS400_LIB> node --env-file=.env --env-file=.env.verify scripts/build-dscmd.mjs`
// （`scripts/host-src/dscmd.c` の WINERR / WINERRLONG / WINERR22 / WINERR22LONG。窓を開いて 0x22〔開始桁 12・終了桁 29〕を撃ち READ MDT で止まる。
//   WEC / WEC22 / WEC22LONG は 0x21 を撃つ）。
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

// [モード, ACS の行, ACS の書き始めの桁（属性の桁）, ACS に出た本文（0x21 の 90 字は先頭 26 字と長さで見る）, 0x21 なら幅（1 行全体）]
const LONG90 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
const CASES = [
  ["WINERR", 24, 1, "ERR IN WINDOW"],
  ["WINERRLONG", 24, 1, "ABCDEFGHIJKLMNOPQ"],
  ["WINERR22", 22, 12, "ERR IN WINDOW"],
  ["WINERR22LONG", 22, 12, "ABCDEFGHIJKLMNOPQ"],
  ["WEC", 24, 1, "ERROR ON MSGLINE", 80],
  ["WEC22", 22, 1, "ERROR ON MSGLINE", 80],
  ["WEC22LONG", 22, 1, LONG90, 80]
];

const s = await Session5250.connect({ host: process.env.AS400_HOST, ccsid: 930 });
await sleep(1000);
const [u, p] = inputs(s);
s.setField({ index: u.index }, process.env.AS400_USER);
s.setField({ index: p.index }, process.env.AS400_PASSWORD);
await s.sendAid("Enter", { cursor: { row: u.row, col: u.col }, timeoutMs: 15000 });
for (let i = 0; i < 4; i++) { await sleep(800); if (inputs(s).some((f) => f.length >= 50)) break; await s.sendAid("Enter", { timeoutMs: 10000 }).catch(() => {}); }
for (const [mode, row, col, text, width] of CASES) {
  const cmd = inputs(s).find((f) => f.length >= 50);
  s.setField({ index: cmd.index }, `CALL ${LIB}/DSCMD PARM('${mode}')`);
  void s.sendAid("Enter", { cursor: { row: cmd.row, col: cmd.col }, timeoutMs: 20000 }).catch(() => {});
  await sleep(3000);
  const snap = s.snapshot();
  log(`${mode}: systemMessage=${JSON.stringify(snap.systemMessage)} area=${JSON.stringify(snap.systemMessageArea)}`);
  if (text === LONG90) check(snap.systemMessage?.length === 90 && snap.systemMessage.startsWith(LONG90), `${mode}: 本文 90 字を保持（先頭 ${LONG90}）`);
  else check(snap.systemMessage === text, `${mode}: 本文が ACS と同じ（${text}）`);
  check(snap.systemMessageArea?.row === row && snap.systemMessageArea?.col === col, `${mode}: 行 ${row}・桁 ${col} から（ACS と同じ）`);
  if (width !== undefined) check(snap.systemMessageArea?.width === width, `${mode}: 幅 ${width}（メッセージ行の 1 行全体。続きを次の行へは出さない——D2）`);
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
