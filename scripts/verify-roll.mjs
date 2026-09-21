// 実機検証（tn5250）: **ROLL で空いた行に旧い内容が残るか**（ACS と同じか。`20260921-roll-vacated-rows`）。
//
// 前提: `DSCMD_LIB=<AS400_LIB> DSCMD_PGM=ROLLTST node --env-file=.env --env-file=.env.verify scripts/build-dscmd.mjs`
// （行 1〜24 に "ROW nn" を書いた画面を出し、行 2〜20 を 3 行ロールして 8 秒待つ試験プログラム。`scripts/host-src/dscmd.c` の ROLLTEST）。
// ACS のコアの結果は `scripts/acs-probe/roll-vacated-{up,down}.txt`。**終わったら DLTPGM と IFS の /tmp/rolltst.* を消す**。
//
// 実行: node --env-file=.env --env-file=.env.verify scripts/verify-roll.mjs
//   AS400_USER / AS400_PASSWORD / AS400_HOST（`.env`）、AS400_LIB（`.env.verify`）
import { Session5250 } from "@ts5250/tn5250";

const LIB = (process.env.AS400_LIB ?? "TESTLIB").trim().split(/\s+/)[0];
const log = (s) => process.stderr.write(`${s}\n`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const inputs = (s) => s.snapshot().fields.filter((f) => !f.protected);
const rowText = (s, r) => s.snapshot().cells[r - 1].map((c) => c.char).join("").slice(0, 10).trim();
let pass = 0, fail = 0;
const check = (c, m) => { if (c) { pass++; log(`  PASS ${m}`); } else { fail++; log(`  FAIL ${m}`); } };

for (const [dir, kept, moved] of [["UP", [18, 19, 20], [2, 5]], ["DOWN", [2, 3, 4], [5, 2]]]) {
  const s = await Session5250.connect({ host: process.env.AS400_HOST, ccsid: 930 });
  await sleep(1000);
  const [u, p] = inputs(s);
  s.setField({ index: u.index }, process.env.AS400_USER);
  s.setField({ index: p.index }, process.env.AS400_PASSWORD);
  await s.sendAid("Enter", { cursor: { row: u.row, col: u.col }, timeoutMs: 15000 });
  for (let i = 0; i < 4; i++) { await sleep(800); if (inputs(s).some((f) => f.length >= 50)) break; await s.sendAid("Enter", { timeoutMs: 10000 }).catch(() => {}); }
  const cmd = inputs(s).find((f) => f.length >= 50);
  s.setField({ index: cmd.index }, `CALL ${LIB}/ROLLTST PARM('ROLLTEST${dir}')`);
  void s.sendAid("Enter", { cursor: { row: cmd.row, col: cmd.col }, timeoutMs: 20000 }).catch(() => {});
  await sleep(3000);
  check(rowText(s, moved[0]) === `ROW ${String(moved[1]).padStart(2, "0")}`, `${dir}: 行 ${moved[0]} に ROW ${moved[1]} が送られた`);
  check(kept.every((r) => rowText(s, r) === `ROW ${String(r).padStart(2, "0")}`), `${dir}: 空いた行 ${kept.join("・")} に旧い内容が残る（ACS と同じ）`);
  await sleep(8000);
  const c2 = inputs(s).find((f) => f.length >= 50);
  if (c2) { s.setField({ index: c2.index }, "SIGNOFF"); await s.sendAid("Enter", { cursor: { row: c2.row, col: c2.col }, timeoutMs: 10000 }).catch(() => {}); }
  await sleep(500);
  s.disconnect();
}
log(`RESULT: pass=${pass} fail=${fail}`);
process.exit(fail > 0 ? 1 : 0);
