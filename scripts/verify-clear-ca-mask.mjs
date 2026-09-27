// 実機検証（tn5250）: **CLEAR UNIT ALTERNATE・CLEAR FORMAT TABLE で SOH の CA キーの申告を捨てるか**（`20260927-clear-ca-mask`）。
//
// 前提: `DSCMD_LIB=<AS400_LIB> node --env-file=.env --env-file=.env.verify scripts/build-dscmd.mjs`（`scripts/host-src/dscmd.c` の CACUA / CACFT / CANONE）。
// ACS のコア（`scripts/acs-probe/clear-ca-mask.txt`）: AB を打って F3 → CANONE は `07 0c 33`（申告どおり欄なし）、CACUA・CACFT は `07 0c 33 11 07 0a c1 c2`（申告が捨てられ欄を送る）。
// **モードごとに繋ぎ直す**。**終わったら DLTPGM と IFS の /tmp/dscmd.* を消す**。
//
// 実行: node --env-file=.env --env-file=.env.verify scripts/verify-clear-ca-mask.mjs [モード…]
import { Session5250 } from "@ts5250/tn5250";
import { IfsConnection } from "@ts5250/hostserver";
import { codecForCcsid } from "@ts5250/ebcdic";

const LIB = (process.env.AS400_LIB ?? "TESTLIB").trim().split(/\s+/)[0];
const ACS = { CANONE: "070c33", CACUA: "070c3311070ac1c2", CACFT: "070c3311070ac1c2" };
const MODES = process.argv.slice(2).length ? process.argv.slice(2) : Object.keys(ACS);
const log = (s) => process.stderr.write(`${s}\n`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const inputs = (s) => s.snapshot().fields.filter((f) => !f.protected);
let pass = 0, fail = 0;
const check = (c, m) => { if (c) { pass++; log(`  PASS ${m}`); } else { fail++; log(`  FAIL ${m}`); } };
const readLog = async () => {
  const ifs = await IfsConnection.connect({ host: process.env.AS400_HOST, user: process.env.AS400_USER, password: process.env.AS400_PASSWORD });
  const t = await ifs.readTextFile("/tmp/dscmd.log");
  const bytes = t?.data ?? t;
  ifs.close?.();
  return typeof bytes === "string" ? bytes : codecForCcsid(t?.ccsid ?? 37).decode(Uint8Array.from(Object.values(bytes)));
};

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
  await s.sendAid("Enter", { cursor: { row: cmd.row, col: cmd.col }, timeoutMs: 20000 });
  await sleep(1500);
  const f = inputs(s).find((x) => x.row === 7 && x.col === 10);
  if (f) s.setField({ index: f.index }, "AB");
  await s.sendAid("F3", { cursor: { row: 7, col: 12 }, timeoutMs: 15000 }).catch(() => {});
  await sleep(1500);
  const c2 = inputs(s).find((x) => x.length >= 50);
  if (c2) { s.setField({ index: c2.index }, "SIGNOFF"); await s.sendAid("Enter", { cursor: { row: c2.row, col: c2.col }, timeoutMs: 10000 }).catch(() => {}); }
  await sleep(500);
  s.disconnect();
  const dta = /\[READ\] QsnRtvDta len=\d+ hex=([0-9a-f]*)/.exec(await readLog())?.[1];
  log(`  READ が受けた: ${dta}`);
  check(dta === ACS[mode], `${mode}: F3 の欄データが ACS と同じ（${ACS[mode]}）`);
  await sleep(1500);
}
log(`RESULT: pass=${pass} fail=${fail}`);
process.exit(fail > 0 ? 1 : 0);
