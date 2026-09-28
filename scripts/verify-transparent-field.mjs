// 実機検証（tn5250）: **透過の欄（FCW 0x8400）を ACS と同じ形で送るか**（台帳「DS5250 の残り」の FCW 0x84xx）。
//
// 前提: `DSCMD_LIB=<AS400_LIB> node --env-file=.env --env-file=.env.verify scripts/build-dscmd.mjs`（`scripts/host-src/dscmd.c` の TRANSP）。
// ACS のコア（`scripts/acs-probe/transparent-field.txt`）: `AB` の後ろに X を打った 8 桁の透過の欄と、`CD` の後ろに Y を打った素の欄を READ MDT で
// `11050a 10 0008 c1c2e70000000000 11070a c3c4e8` と送った。
// **終わったら DLTPGM と IFS の /tmp/dscmd.c・/tmp/dscmd.log を消す**。
//
// 実行: node --env-file=.env --env-file=.env.verify scripts/verify-transparent-field.mjs
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
s.setField({ index: cmd.index }, `CALL ${LIB}/DSCMD PARM('TRANSP')`);
void s.sendAid("Enter", { cursor: { row: cmd.row, col: cmd.col }, timeoutMs: 20000 }).catch(() => {});
await sleep(4000);
s.setField({ row: 5, col: 10 }, "ABX");
s.setField({ row: 7, col: 10 }, "CDY");
await s.sendAid("Enter", { cursor: { row: 7, col: 13 }, timeoutMs: 10000 }).catch(() => {});
await sleep(3000); // 2 回目（READ INPUT）は DSM 側が CPFA306 で待たずに終わる
const c2 = inputs(s).find((f) => f.length >= 50);
if (c2) { s.setField({ index: c2.index }, "SIGNOFF"); await s.sendAid("Enter", { cursor: { row: c2.row, col: c2.col }, timeoutMs: 10000 }).catch(() => {}); }
await sleep(500);
s.disconnect();

const ifs = await IfsConnection.connect({ host: process.env.AS400_HOST, user: process.env.AS400_USER, password: process.env.AS400_PASSWORD });
const t = await ifs.readTextFile("/tmp/dscmd.log");
const bytes = t?.data ?? t;
const text = typeof bytes === "string" ? bytes : codecForCcsid(t?.ccsid ?? 37).decode(Uint8Array.from(Object.values(bytes)));
ifs.close?.();
const got = text.match(/^\[MDT\] QsnRtvFldDta len=\d+ hex=([0-9a-f]*)/m)?.[1];
log(`  READ MDT の欄データ=${got}`);
check(got === "11050a100008c1c2e7000000000011070ac3c4e8", "透過の欄は ACS と同じ `10 00 08`＋ヌルも含む生バイト");
log(`RESULT: pass=${pass} fail=${fail}`);
process.exit(fail > 0 ? 1 : 0);
