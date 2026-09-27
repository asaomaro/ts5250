// 実機検証（tn5250）: **READ の欄データの加工**（`20260927-read-alt-raw`）——ALT（0x83・0x82）は加工せず、0x52 は NUL と符号を加工する。どちらも末尾の実空白は送る。
//
// 前提: `DSCMD_LIB=<AS400_LIB> [DSCMD_PGM=<名前>] node --env-file=.env --env-file=.env.verify scripts/build-dscmd.mjs`（`scripts/host-src/dscmd.c` の READALT）。
// 期待値は実機の ACS のコアで採った値（`scripts/acs-probe/read-alt.txt`。ホスト側のログの `flddta`）。
// **終わったら DLTPGM と IFS の /tmp/<名前>.c・/tmp/<名前>.log を消す**。
//
// 実行: node --env-file=.env --env-file=.env.verify scripts/verify-read-alt.mjs
import { Session5250 } from "@ts5250/tn5250";
import { IfsConnection } from "@ts5250/hostserver";
import { codecForCcsid } from "@ts5250/ebcdic";

const LIB = (process.env.AS400_LIB ?? "TESTLIB").trim().split(/\s+/)[0];
const PGM = process.env.DSCMD_PGM ?? "DSCMD";
const LOGF = `/tmp/${PGM.toLowerCase()}.log`;
// ACS のコアが送った欄データ（欄 1〜6。ホストが QsnRtvFldInf で分けたもの）
const ACS = {
  "0x83": ["c1c240c3404040404040", "c100c2", "4040f0f1f260", "404040f1f240", "40404040c160", "404040404060"],
  "0x82": ["c1c240c3404040404040", "c100c2", "4040f0f1f260", "404040f1f240", "40404040c160", "404040404060"],
  "0x52": ["c1c240c3404040404040", "c140c2", "4040f0f1d2", "404040f1f2", "40404040d1", "40404040d0"]
};
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
s.setField({ index: cmd.index }, `CALL ${LIB}/${PGM} PARM('READALT')`);
void s.sendAid("Enter", { cursor: { row: cmd.row, col: cmd.col }, timeoutMs: 20000 }).catch(() => {});
await sleep(5000); // 0x83 は即答。0x82 で Enter を待っている
await s.sendAid("Enter", { timeoutMs: 10000 }).catch(() => {});
await sleep(3000); // 0x52 で Enter を待っている
await s.sendAid("Enter", { timeoutMs: 10000 }).catch(() => {});
await sleep(3000);
const c2 = inputs(s).find((f) => f.length >= 50);
if (c2) { s.setField({ index: c2.index }, "SIGNOFF"); await s.sendAid("Enter", { cursor: { row: c2.row, col: c2.col }, timeoutMs: 10000 }).catch(() => {}); }
await sleep(500);
s.disconnect();

const ifs = await IfsConnection.connect({ host: process.env.AS400_HOST, user: process.env.AS400_USER, password: process.env.AS400_PASSWORD });
const t = await ifs.readTextFile(LOGF);
const bytes = t?.data ?? t;
const text = typeof bytes === "string" ? bytes : codecForCcsid(t?.ccsid ?? 37).decode(Uint8Array.from(Object.values(bytes)));
ifs.close?.();
for (const [tag, want] of Object.entries(ACS)) {
  const got = [...text.matchAll(new RegExp(`^\\[${tag}\\]\\s+flddta len=\\d+ hex=([0-9a-f]*)`, "gm"))].map((m) => m[1]);
  log(`### ${tag} 当 PJ=${JSON.stringify(got)}`);
  check(JSON.stringify(got) === JSON.stringify(want), `${tag} の欄データが ACS と同じ（${JSON.stringify(want)}）`);
}
log(`RESULT: pass=${pass} fail=${fail}`);
process.exit(fail > 0 ? 1 : 0);
