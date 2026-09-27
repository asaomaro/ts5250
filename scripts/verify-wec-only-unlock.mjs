// 実機検証（tn5250）: **READ の無い WRITE ERROR CODE だけのレコードの後、Reset で打鍵でき、先に押した Enter は後の READ に届くか**（`20260927-wec-only-unlock`）。
//
// 前提: `DSCMD_LIB=<AS400_LIB> node --env-file=.env --env-file=.env.verify scripts/build-dscmd.mjs`（`scripts/host-src/dscmd.c` の WECONLY）。
// ACS のコア（`scripts/acs-probe/wec-only-unlock.txt`）: 0x21 の後はエラー状態（inhibit 5）、Reset で解け、`AB` を打って Enter →
// 10 秒後の READ MDT が AID F1・カーソル 5,12・欄 `c1c2` を受けた。**終わったら DLTPGM と IFS の /tmp/dscmd.* を消す**。
//
// `WECTWICE` を付けると、2 回目の 0x21 が溜めた Enter を捨てるかを見る（ACS のコア `scripts/acs-probe/wec-twice.txt`: READ は後で押した F3〔`05 0a 33`〕を受けた）。
//
// 実行: node --env-file=.env --env-file=.env.verify scripts/verify-wec-only-unlock.mjs [WECTWICE]
import { Session5250 } from "@ts5250/tn5250";
import { IfsConnection } from "@ts5250/hostserver";
import { codecForCcsid } from "@ts5250/ebcdic";

const LIB = (process.env.AS400_LIB ?? "TESTLIB").trim().split(/\s+/)[0];
const MODE = ["WECTWICE", "WECONLYW"].includes(process.argv[2]) ? process.argv[2] : "WECONLY";
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
s.setField({ index: cmd.index }, `CALL ${LIB}/DSCMD PARM('${MODE}')`);
const first = s.sendAid("Enter", { cursor: { row: cmd.row, col: cmd.col }, timeoutMs: 20000 }).catch((e) => ({ err: String(e) }));
await sleep(3000);
const snap = s.snapshot();
log(`  0x21 の後: 施錠=${snap.keyboardLocked} エラー=${JSON.stringify(snap.systemMessage ?? snap.hostError ?? null)?.slice(0, 60)}`);
const r1 = await Promise.race([first, sleep(100).then(() => "pending")]);
log(`  最初の AID の待ち: ${typeof r1 === "string" ? r1 : r1.timedOut ? "timedOut" : "resolved"}`);
check(snap.keyboardLocked === false, "0x21 だけのレコードで施錠が解ける（ACS `initKeyboard`。エラー状態のまま）");
check(typeof r1 !== "string" && r1.timedOut === false, "最初の AID の待ちはエラーの画面で解ける");
s.dismissHostError?.();
const f = inputs(s).find((x) => x.row === 5 && x.col === 10);
let sent;
try {
  if (f) s.setField({ index: f.index }, "AB");
  sent = await s.sendAid("Enter", { cursor: { row: 5, col: 12 }, timeoutMs: 15000 });
} catch (e) { sent = { err: String(e) }; }
log(`  Reset → AB → Enter: ${JSON.stringify(sent?.err ?? (sent?.timedOut ? "timedOut" : "ok"))}`);
if (MODE === "WECTWICE") {
  // 2 回目の 0x21（10 秒後）→ 10 秒後に READ。溜めた Enter は捨てられるので、READ の後に F3 を押す
  await sleep(18000);
  s.dismissHostError?.();
  await s.sendAid("F3", { timeoutMs: 15000 }).catch(() => {});
}
await sleep(12000);
const c2 = inputs(s).find((x) => x.length >= 50);
if (c2) { s.setField({ index: c2.index }, "SIGNOFF"); await s.sendAid("Enter", { cursor: { row: c2.row, col: c2.col }, timeoutMs: 10000 }).catch(() => {}); }
await sleep(500);
s.disconnect();
const ifs = await IfsConnection.connect({ host: process.env.AS400_HOST, user: process.env.AS400_USER, password: process.env.AS400_PASSWORD });
const t = await ifs.readTextFile("/tmp/dscmd.log");
const bytes = t?.data ?? t;
const text = typeof bytes === "string" ? bytes : codecForCcsid(t?.ccsid ?? 37).decode(Uint8Array.from(Object.values(bytes)));
ifs.close?.();
const dta = /\[READ\] QsnRtvDta len=\d+ hex=([0-9a-f]*)/.exec(text)?.[1];
log(`  ホストの READ が受けた: ${dta}`);
// 溜めた AID は押したときのカーソルで送る（`20260927-unlocked-wtd-cursor`。以前は当 PJ だけ 5,10 になっていた）
// ⚠ ACS は F3 に欄（AB）を付けなかった（`05 0a 33`。3 回とも）。溜めた Enter を押さずに AB だけ打った場合は ACS も F3 に AB を付けた（`…33 11 05 0a c1 c2`）。
// 早い Enter の何が欄を落とすのかは原典から読めなかった（未確認。台帳）ので、ここでは AID だけを見る
if (MODE === "WECTWICE") check(dta?.slice(4, 6) === "33", "2 回目の 0x21 が溜めた Enter を捨て、READ は後で押した F3 を受ける（ACS と同じ AID）");
else check(dta === "050cf111050ac1c2", "後の READ が Enter（F1）・欄 AB を受ける（ACS と同じ `050cf111050ac1c2`。カーソルは押したときの位置——WECONLYW は READ の前の WTD が書いても同じ）");
log(`RESULT: pass=${pass} fail=${fail}`);
process.exit(fail > 0 ? 1 : 0);
