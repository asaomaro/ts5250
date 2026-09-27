// 実機検証（tn5250）: **解錠中に届いた WTD でカーソルが動くか**（`20260927-unlocked-wtd-cursor`）。
//
// 前提: `DSCMD_LIB=<AS400_LIB> node --env-file=.env --env-file=.env.verify scripts/build-dscmd.mjs`（`scripts/host-src/dscmd.c` の UNLOCKWTD*）。
// ACS のコア（`scripts/acs-probe/unlocked-wtd-cursor.txt`）: 1 本目（CC2 で解錠・IC 5,10）の後にカーソルを 9,2 へ動かしても、2 本目（WTD＋READ）で
// UNLOCKWTD・UNLOCKWTDCC1 は 7,10（IC）、UNLOCKWTDNOIC は 5,10 へ動いた（ACS の Enter の READ も同じ位置。このスクリプトは READ の位置を見ない）。**終わったら DLTPGM と IFS の /tmp/dscmd.* を消す**。
//
// 実行: node --env-file=.env --env-file=.env.verify scripts/verify-unlocked-wtd-cursor.mjs [モード…]
import { Session5250 } from "@ts5250/tn5250";
import { IfsConnection } from "@ts5250/hostserver";
import { codecForCcsid } from "@ts5250/ebcdic";

const LIB = (process.env.AS400_LIB ?? "TESTLIB").trim().split(/\s+/)[0];
const ACS = { UNLOCKWTD: [7, 10], UNLOCKWTDNOIC: [5, 10], UNLOCKWTDCC1: [7, 10] };
const MODES = process.argv.slice(2).length ? process.argv.slice(2) : Object.keys(ACS);
const log = (s) => process.stderr.write(`${s}\n`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const inputs = (s) => s.snapshot().fields.filter((f) => !f.protected);
let pass = 0, fail = 0;
const check = (c, m) => { if (c) { pass++; log(`  PASS ${m}`); } else { fail++; log(`  FAIL ${m}`); } };
for (const mode of MODES) {
  log(`### ${mode}`);
  const s = await Session5250.connect({ host: process.env.AS400_HOST, ccsid: 930, warn: () => {} });
  await sleep(1000);
  const [u, p] = inputs(s);
  s.setField({ index: u.index }, process.env.AS400_USER);
  s.setField({ index: p.index }, process.env.AS400_PASSWORD);
  await s.sendAid("Enter", { cursor: { row: u.row, col: u.col }, timeoutMs: 15000 });
  for (let i = 0; i < 4; i++) { await sleep(800); if (inputs(s).some((f) => f.length >= 50)) break; await s.sendAid("Enter", { timeoutMs: 10000 }).catch(() => {}); }
  const cmd = inputs(s).find((f) => f.length >= 50);
  if (!cmd) { check(false, `${mode}: コマンド行が出ない`); s.disconnect(); continue; }
  s.setField({ index: cmd.index }, `CALL ${LIB}/DSCMD PARM('${mode}')`);
  void s.sendAid("Enter", { cursor: { row: cmd.row, col: cmd.col }, timeoutMs: 20000 }).catch(() => {});
  await sleep(3000);
  // ⚠ ACS のプローブは待つ間にカーソルを 9,2 へ動かすが、コアにはカーソルを動かす口が無い（画面の側のキャレットの話）ので再現しない。
  // そのため IC の無い UNLOCKWTDNOIC の 5,10 は「動いたか」を区別しない——IC 7,10 の 2 通りだけが WTD がカーソルを置くことの検査になる
  await sleep(7000);
  const c = s.snapshot().cursor;
  log(`  2 本目の後のカーソル: ${c?.row},${c?.col}`);
  check(c?.row === ACS[mode][0] && c?.col === ACS[mode][1], `${mode}: カーソルが ACS と同じ ${ACS[mode].join(",")}`);
  await s.sendAid("Enter", { timeoutMs: 10000 }).catch(() => {});
  await sleep(1500);
  const c2 = inputs(s).find((x) => x.length >= 50);
  if (c2) { s.setField({ index: c2.index }, "SIGNOFF"); await s.sendAid("Enter", { cursor: { row: c2.row, col: c2.col }, timeoutMs: 10000 }).catch(() => {}); }
  await sleep(500);
  s.disconnect();
  await sleep(1500);
}
log(`RESULT: pass=${pass} fail=${fail}`);
process.exit(fail > 0 ? 1 : 0);
