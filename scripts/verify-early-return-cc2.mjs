// 実機検証（tn5250）: **同じレコードの後ろで否定応答になったとき、先に来た WTD の CC2（メッセージ待ち）が効くか**（`20260927-early-return-cc2`）。
//
// 前提: `DSCMD_LIB=<AS400_LIB> node --env-file=.env --env-file=.env.verify scripts/build-dscmd.mjs`
// （`scripts/host-src/dscmd.c` の EARLYROLL。先にメッセージ待ちを消し、1 本のレコードに WTD〔CC2＝0x01〕＋不正な ROLL → 8 秒待つ → メッセージ待ちを消す）。
// ACS のコアの結果は `scripts/acs-probe/early-return-cc2.txt`。**終わったら DLTPGM <AS400_LIB>/DSCMD と IFS の /tmp/dscmd.c・/tmp/dscmd.log を消す**。
//
// 実行: node --env-file=.env --env-file=.env.verify scripts/verify-early-return-cc2.mjs
import { Session5250 } from "@ts5250/tn5250";

const LIB = (process.env.AS400_LIB ?? "TESTLIB").trim().split(/\s+/)[0];
const log = (s) => process.stderr.write(`${s}\n`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const inputs = (s) => s.snapshot().fields.filter((f) => !f.protected);
const warns = [];
let pass = 0, fail = 0;
const check = (c, m) => { if (c) { pass++; log(`  PASS ${m}`); } else { fail++; log(`  FAIL ${m}`); } };

const s = await Session5250.connect({ host: process.env.AS400_HOST, ccsid: 930, warn: (w) => warns.push(w) });
await sleep(1000);
const [u, p] = inputs(s);
s.setField({ index: u.index }, process.env.AS400_USER);
s.setField({ index: p.index }, process.env.AS400_PASSWORD);
await s.sendAid("Enter", { cursor: { row: u.row, col: u.col }, timeoutMs: 15000 });
for (let i = 0; i < 4; i++) { await sleep(800); if (inputs(s).some((f) => f.length >= 50)) break; await s.sendAid("Enter", { timeoutMs: 10000 }).catch(() => {}); }
const state = (label) => {
  const snap = s.snapshot();
  const row5 = snap.cells[4].map((c) => c.char).join("").trim();
  log(`${label}: mw=${snap.messageWaiting === true} locked=${snap.keyboardLocked} row5=${JSON.stringify(row5)}`);
  return { mw: snap.messageWaiting === true, row5 };
};
state("前");
const cmd = inputs(s).find((f) => f.length >= 50);
s.setField({ index: cmd.index }, `CALL ${LIB}/DSCMD PARM('EARLYROLL')`);
const n = warns.length;
void s.sendAid("Enter", { cursor: { row: cmd.row, col: cmd.col }, timeoutMs: 20000 }).catch(() => {});
await sleep(1500);
check(!state("先に消した後").mw, "先に消した WTD でメッセージ待ちが消えた（前提）");
await sleep(4500);
const e = state("EARLYROLL の後（8 秒の待ちの中）");
log(`  警告: ${JSON.stringify(warns.slice(n))}`);
check(e.row5 === "EARLY ROLL", "WTD は画面に書かれた（ACS も 5 行目に EARLY ROLL）");
check(warns.slice(n).some((w) => w.includes("0x1005012C")), "不正な ROLL に否定応答 0x1005012C");
check(!e.mw, "メッセージ待ちは点かない（ACS のコアも点けない。同じレコードの CC2 を落とす）");
await sleep(8000);
state("メッセージ待ちを消した後");
const c2 = inputs(s).find((f) => f.length >= 50);
if (c2) { s.setField({ index: c2.index }, "SIGNOFF"); await s.sendAid("Enter", { cursor: { row: c2.row, col: c2.col }, timeoutMs: 10000 }).catch(() => {}); }
await sleep(500);
s.disconnect();
log(`RESULT: pass=${pass} fail=${fail}`);
process.exit(fail > 0 ? 1 : 0);
