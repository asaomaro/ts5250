// 実機検証（tn5250）: **その場で戻る否定応答の残り**（`20260927-early-return-rest`）——READ の CC2・引数の無い CLEAR UNIT ALTERNATE・SAVE PARTIAL の応答の順。
//
// 前提: `DSCMD_LIB=<AS400_LIB> node --env-file=.env --env-file=.env.verify scripts/build-dscmd.mjs`（`scripts/host-src/dscmd.c` の READCC2 / CUANOPARM / SPROLL）。
// ACS のコアの結果は `scripts/acs-probe/early-return-rest.txt`（READ の CC2 は効かない・引数の無い CUA は否定応答にせず消す・否定応答の後に SAVE PARTIAL の応答）。
// **モードごとに繋ぎ直す**（否定応答の後の CALL は効かない）。**終わったら DLTPGM と IFS の /tmp/dscmd.* を消す**。
//
// 実行: node --env-file=.env --env-file=.env.verify scripts/verify-early-return-rest.mjs [モード…]
import { Session5250 } from "@ts5250/tn5250";

const LIB = (process.env.AS400_LIB ?? "TESTLIB").trim().split(/\s+/)[0];
const MODES = process.argv.slice(2).length ? process.argv.slice(2) : ["READCC2", "CUANOPARM", "SPROLL"];
const log = (s) => process.stderr.write(`${s}\n`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const inputs = (s) => s.snapshot().fields.filter((f) => !f.protected);
let pass = 0, fail = 0;
const check = (c, m) => { if (c) { pass++; log(`  PASS ${m}`); } else { fail++; log(`  FAIL ${m}`); } };
for (const mode of MODES) {
  log(`### ${mode}`);
  const s = await Session5250.connect({ host: process.env.AS400_HOST, ccsid: 930, warn: () => {} });
  const sent = [];
  const orig = s.telnet.sendRecord.bind(s.telnet); // private だが測定のためだけ
  s.telnet.sendRecord = (rec) => { sent.push(Array.from(rec, (b) => b.toString(16).padStart(2, "0")).join("")); orig(rec); };
  await sleep(1000);
  const [u, p] = inputs(s);
  s.setField({ index: u.index }, process.env.AS400_USER);
  s.setField({ index: p.index }, process.env.AS400_PASSWORD);
  await s.sendAid("Enter", { cursor: { row: u.row, col: u.col }, timeoutMs: 15000 });
  for (let i = 0; i < 4; i++) { await sleep(800); if (inputs(s).some((f) => f.length >= 50)) break; await s.sendAid("Enter", { timeoutMs: 10000 }).catch(() => {}); }
  const cmd = inputs(s).find((f) => f.length >= 50);
  if (!cmd) { check(false, `${mode}: コマンド行が出ない`); s.disconnect(); continue; }
  s.setField({ index: cmd.index }, `CALL ${LIB}/DSCMD PARM('${mode}')`);
  const n = sent.length;
  void s.sendAid("Enter", { cursor: { row: cmd.row, col: cmd.col }, timeoutMs: 20000 }).catch(() => {});
  await sleep(6000);
  const snap = s.snapshot();
  const row5 = snap.cells[4].map((c) => c.char).join("").trim();
  const kinds = sent.slice(n).map((h) => (h.slice(20, 28) === "04800000" ? "neg" : h.slice(20, 24) === "0412" ? "save" : "other"));
  log(`  窓の中: mw=${snap.messageWaiting === true} row5=${JSON.stringify(row5)} 送った=${JSON.stringify(kinds)}`);
  if (mode === "READCC2") check(snap.messageWaiting !== true && row5 === "READCC2", "READ の CC2 は効かない（ACS と同じ）");
  if (mode === "CUANOPARM") {
    check(row5 === "" && snap.messageWaiting === true, "引数の無い CUA で画面が消え、WTD の CC2 は効く（ACS と同じ）");
    check(!kinds.includes("neg"), "否定応答にしない（ACS と同じ）");
  }
  await sleep(8000);
  if (mode === "SPROLL") {
    const all = sent.slice(n).map((h) => (h.slice(20, 28) === "04800000" ? "neg" : h.slice(20, 24) === "0412" ? "save" : "other")).filter((k) => k !== "other");
    log(`  次のレコードの後: ${JSON.stringify(all)}`);
    check(all[0] === "neg" && all[1] === "save", "否定応答が先で SAVE PARTIAL の応答はその後（ACS と同じ）");
  }
  await s.sendAid("Enter", { timeoutMs: 10000 }).catch(() => {});
  await sleep(1500);
  const c2 = inputs(s).find((f) => f.length >= 50);
  if (c2) { s.setField({ index: c2.index }, "SIGNOFF"); await s.sendAid("Enter", { cursor: { row: c2.row, col: c2.col }, timeoutMs: 10000 }).catch(() => {}); }
  await sleep(500);
  s.disconnect();
  await sleep(1500);
}
log(`RESULT: pass=${pass} fail=${fail}`);
process.exit(fail > 0 ? 1 : 0);
