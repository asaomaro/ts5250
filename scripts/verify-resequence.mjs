// 実機検証（tn5250）: **再順序付け（SOH の本体 3 バイト目＋FCW 0x80nn）で READ MDT の欄の並びが ACS と同じになるか**（台帳「DS5250 の残り」の FCW 0x80xx）。
//
// 前提: `DSCMD_LIB=<AS400_LIB> node --env-file=.env --env-file=.env.verify scripts/build-dscmd.mjs`（`scripts/host-src/dscmd.c` の RESEQ。鎖は #2(7,10) → #1(5,10) → #3(9,10)）。
// ACS のコア（`scripts/acs-probe/resequence.txt`）: 3 欄に A・B・C を打つと `11070ac2 11050ac1 11090ac3`（鎖の順）、#2・#3 だけに打つと `11070ac2` だけ
// （辿った先の #1 が MDT でないので鎖が止まる）。
// **終わったら DLTPGM と IFS の /tmp/dscmd.c・/tmp/dscmd.log を消す**。
//
// 実行: node --env-file=.env --env-file=.env.verify scripts/verify-resequence.mjs
import { Session5250 } from "@ts5250/tn5250";
import { IfsConnection } from "@ts5250/hostserver";
import { codecForCcsid } from "@ts5250/ebcdic";

const LIB = (process.env.AS400_LIB ?? "TESTLIB").trim().split(/\s+/)[0];
const log = (s) => process.stderr.write(`${s}\n`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const inputs = (s) => s.snapshot().fields.filter((f) => !f.protected);
let pass = 0, fail = 0;
const check = (c, m) => { if (c) { pass++; log(`  PASS ${m}`); } else { fail++; log(`  FAIL ${m}`); } };

const s = await Session5250.connect({ host: process.env.AS400_HOST, ccsid: 930, warn: () => {} });
await sleep(1000);
const [u, p] = inputs(s);
s.setField({ index: u.index }, process.env.AS400_USER);
s.setField({ index: p.index }, process.env.AS400_PASSWORD);
await s.sendAid("Enter", { cursor: { row: u.row, col: u.col }, timeoutMs: 15000 });
for (let i = 0; i < 4; i++) { await sleep(800); if (inputs(s).some((f) => f.length >= 50)) break; await s.sendAid("Enter", { timeoutMs: 10000 }).catch(() => {}); }
const cmd = inputs(s).find((f) => f.length >= 50);
if (!cmd) { log("コマンド行が出ない"); process.exit(1); }
s.setField({ index: cmd.index }, `CALL ${LIB}/DSCMD PARM('RESEQ')`);
void s.sendAid("Enter", { cursor: { row: cmd.row, col: cmd.col }, timeoutMs: 20000 }).catch(() => {});
await sleep(4000);
s.setField({ row: 5, col: 10 }, "A");
s.setField({ row: 7, col: 10 }, "B");
s.setField({ row: 9, col: 10 }, "C");
await s.sendAid("Enter", { cursor: { row: 5, col: 10 }, timeoutMs: 10000 }).catch(() => {});
await sleep(3000);
s.setField({ row: 7, col: 10 }, "B");
s.setField({ row: 9, col: 10 }, "C");
await s.sendAid("Enter", { cursor: { row: 5, col: 10 }, timeoutMs: 10000 }).catch(() => {});
await sleep(3000);
const c2 = inputs(s).find((f) => f.length >= 50);
if (c2) { s.setField({ index: c2.index }, "SIGNOFF"); await s.sendAid("Enter", { cursor: { row: c2.row, col: c2.col }, timeoutMs: 10000 }).catch(() => {}); }
await sleep(500);
s.disconnect();

const ifs = await IfsConnection.connect({ host: process.env.AS400_HOST, user: process.env.AS400_USER, password: process.env.AS400_PASSWORD });
const t = await ifs.readTextFile("/tmp/dscmd.log");
const bytes = t?.data ?? t;
const text = typeof bytes === "string" ? bytes : codecForCcsid(t?.ccsid ?? 37).decode(Uint8Array.from(Object.values(bytes)));
ifs.close?.();
const of = (tag) => text.match(new RegExp(`^\\[${tag}\\] QsnRtvFldDta len=\\d+ hex=([0-9a-f]*)`, "m"))?.[1];
log(`  1 回目=${of("R1")} 2 回目=${of("R2")}`);
check(of("R1") === "11070ac211050ac111090ac3", "3 欄とも打つと鎖の順（#2 → #1 → #3）で送る（ACS と同じ）");
check(of("R2") === "11070ac2", "#2・#3 だけ打つと #2 だけ（辿った先の #1 が MDT でないので止まる。ACS と同じ）");
log(`RESULT: pass=${pass} fail=${fail}`);
process.exit(fail > 0 ? 1 : 0);
