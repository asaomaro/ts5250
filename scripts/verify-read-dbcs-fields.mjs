// 実機検証（tn5250）: **DBCS の欄の欄データ**（`20260927-read-dbcs-fields`）——ACS `sendAll` は DBCS の欄（O・G・J・E）も末尾の NUL だけを落とし、実空白は送る。
// 0x52 は途中の NUL を 0x40 に、ALT（0x83・0x82）はそのまま。ホストが書いた値のまま（打鍵しない）で読む。
//
// 前提: `DSCMD_LIB=<AS400_LIB> [DSCMD_PGM=<名前>] node --env-file=.env --env-file=.env.verify scripts/build-dscmd.mjs`（`scripts/host-src/dscmd.c` の READDBCS）。
// 期待値は実機の ACS のコアで採った値（`scripts/acs-probe/read-dbcs-fields.txt`。ホスト側のログの `flddta`）。
// **終わったら DLTPGM と IFS の /tmp/<名前>.c・/tmp/<名前>.log を消す**。
//
// 実行: node --env-file=.env --env-file=.env.verify scripts/verify-read-dbcs-fields.mjs
import { Session5250 } from "@ts5250/tn5250";
import { IfsConnection } from "@ts5250/hostserver";
import { codecForCcsid } from "@ts5250/ebcdic";

const LIB = (process.env.AS400_LIB ?? "TESTLIB").trim().split(/\s+/)[0];
const PGM = process.env.DSCMD_PGM ?? "DSCMD";
const LOGF = `/tmp/${PGM.toLowerCase()}.log`;
// ACS のコアが送った応答（カーソルと AID の 3 バイトの後ろ。ホスト側のログの QsnRtvDta）。欄 1〜9。G の欄の `4482` は ACS が `4562` に書き直して送る（同じ字の別の符号）。
// NUL だけの G・O の欄（19,10・21,10）は SBA だけで 0 バイト——`flddta` の行には出ないので、応答をまるごと比べる
const BODY = (nul) => `11050a0e44820f404040404040404011070a0e44820f11090a0e44820f${nul}c1110b0a4562404040404040110d0a4562110f0a0e448240404040404040400f11110a0e44820f11130a11150a`;
const ACS = { "0x83": BODY("00"), "0x82": BODY("00"), "0x52": BODY("40") };
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
s.setField({ index: cmd.index }, `CALL ${LIB}/${PGM} PARM('READDBCS')`);
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
  const m = text.match(new RegExp(`^\\[${tag}\\] QsnRtvDta len=\\d+ hex=([0-9a-f]*)`, "m"));
  const got = m ? m[1].slice(6) : undefined;
  log(`### ${tag} 当 PJ=${got}`);
  check(got === want, `${tag} の欄データが ACS と同じ`);
}
log(`RESULT: pass=${pass} fail=${fail}`);
process.exit(fail > 0 ? 1 : 0);
