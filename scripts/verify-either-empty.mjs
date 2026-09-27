// 実機検証（tn5250）: **全角の状態のまま空にした E 欄は SO の 1 バイトを送るか**（`20260927-either-field-so`）。
//
// 前提: `DSCMD_LIB=<AS400_LIB> node --env-file=.env --env-file=.env.verify scripts/build-dscmd.mjs`（`scripts/host-src/dscmd.c` の READDBCS。E 欄は 17,10 の `SO あ SI`）。
// ACS のコア（`scripts/acs-probe/either-empty.txt`・`either-switch-empty.txt`）: 全角のまま空にした E 欄は `0e`、半角へ切り替えて空にした E 欄は何も送らない。
// Erase Input の後の J 欄は `0e`＋NUL＋`0f`（ALT の読み。0x82）。
// 画面の側は E 欄の状態を `eitherDbcsOn` で添えて送る——ここではその形で `setField` を呼ぶ。0x82 では全角のまま空（`0e`）、0x52 では半角に切り替えて空（何も送らない）。
// **終わったら DLTPGM と IFS の /tmp/dscmd.c・/tmp/dscmd.log を消す**。
//
// 実行: node --env-file=.env --env-file=.env.verify scripts/verify-either-empty.mjs
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
s.setField({ index: cmd.index }, `CALL ${LIB}/DSCMD PARM('READDBCS')`);
void s.sendAid("Enter", { cursor: { row: cmd.row, col: cmd.col }, timeoutMs: 20000 }).catch(() => {});
await sleep(5000); // 0x83 は即答。0x82 で待っている
s.setField({ row: 17, col: 10 }, "", { eitherDbcsOn: true }); // 全角のまま空にした
s.setField({ row: 15, col: 10 }, ""); // J 欄を空に（ACS の Erase Input の後は `0e`＋NUL＋`0f`）
await s.sendAid("Enter", { cursor: { row: 17, col: 11 }, timeoutMs: 10000 }).catch(() => {});
await sleep(3000); // 0x52 で待っている
s.setField({ row: 17, col: 10 }, "", { eitherDbcsOn: false }); // 半角へ切り替えてから空にした
await s.sendAid("Enter", { cursor: { row: 17, col: 10 }, timeoutMs: 10000 }).catch(() => {});
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
const jOf = (tag) => text.match(new RegExp(`^\\[${tag}\\] QsnRtvDta len=\\d+ hex=[0-9a-f]*?110f0a([0-9a-f]*?)11110a`, "m"))?.[1];
const eOf = (tag) => text.match(new RegExp(`^\\[${tag}\\] QsnRtvDta len=\\d+ hex=[0-9a-f]*?11110a([0-9a-f]*?)11130a`, "m"))?.[1];
log(`  0x82 の E 欄=${JSON.stringify(eOf("0x82"))} 0x52 の E 欄=${JSON.stringify(eOf("0x52"))}`);
check(eOf("0x82") === "0e", "全角のまま空にした E 欄は `0e`（ACS と同じ）");
check(eOf("0x52") === "", "半角へ切り替えて空にした E 欄は何も送らない");
log(`  0x82 の J 欄=${JSON.stringify(jOf("0x82"))}`);
check(jOf("0x82") === "0e" + "00".repeat(10) + "0f", "空にした J 欄は `0e`＋NUL＋`0f`（ACS の Erase Input の後と同じ）");
log(`RESULT: pass=${pass} fail=${fail}`);
process.exit(fail > 0 ? 1 : 0);
