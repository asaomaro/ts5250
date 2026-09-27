// 実機検証（tn5250）: **SysReq の行を出している間に届いた WTD を止め、閉じたら流すか**（`20260927-sysreq-line-hold`）。
//
// 前提: `DSCMD_LIB=<AS400_LIB> node --env-file=.env --env-file=.env.verify scripts/build-dscmd.mjs`（`scripts/host-src/dscmd.c` の LATEWTD）。
// ACS のコア（`scripts/acs-probe/sysreq-line-hold.txt`）: 行を出している間に届いた 5 行目の LATE は出ず、Reset で閉じると出た。
// **終わったら DLTPGM と IFS の /tmp/dscmd.* を消す**。
//
// `HOLDCC2` を付けると、保留が始まったレコードの前の WTD の CC2（メッセージ待ち）が、抜けて流し終えてから点くかを見る
// （ACS のコア `scripts/acs-probe/hold-cc2.txt`: 保留の間は消えたまま、Reset の後に点いた）。
//
// `SUBMIT` を付けると、行を Reset ではなく SysReq の送信で閉じる（別の経路でもう一度取る。`measurement-sanity`）。
//
// 実行: node --env-file=.env --env-file=.env.verify scripts/verify-sysreq-line-hold.mjs [HOLDCC2|SUBMIT]
import { Session5250 } from "@ts5250/tn5250";

const LIB = (process.env.AS400_LIB ?? "TESTLIB").trim().split(/\s+/)[0];
const log = (s) => process.stderr.write(`${s}\n`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const inputs = (s) => s.snapshot().fields.filter((f) => !f.protected);
const row = (s, n) => s.snapshot().cells[n - 1].map((c) => c.char).join("").trim();
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
const ARG = process.argv[2] ?? "";
const MODE = ARG === "HOLDCC2" ? "HOLDCC2" : "LATEWTD";
s.setField({ index: cmd.index }, `CALL ${LIB}/DSCMD PARM('${MODE}')`);
if (MODE === "HOLDCC2") {
  void s.sendAid("Enter", { cursor: { row: cmd.row, col: cmd.col }, timeoutMs: 20000 }).catch(() => {});
  await sleep(6000);
  const held = s.snapshot();
  log(`  保留の間: エラー=${JSON.stringify(held.systemMessage ?? null)} mw=${held.messageWaiting === true} 5 行目=${JSON.stringify(row(s, 5))}`);
  check(held.systemMessage !== undefined && held.messageWaiting !== true, "保留の間はメッセージ待ちが点かない（ACS と同じ）");
  s.dismissHostError();
  await sleep(500);
  log(`  抜けた後: mw=${s.snapshot().messageWaiting === true} 5 行目=${JSON.stringify(row(s, 5))}`);
  check(s.snapshot().messageWaiting === true && row(s, 5) === "HELD", "抜けて流し終えたら点く（ACS と同じ）");
  await sleep(9000);
  await s.sendAid("Enter", { timeoutMs: 15000 }).catch(() => {});
  await sleep(1500);
  const c3 = inputs(s).find((x) => x.length >= 50);
  if (c3) { s.setField({ index: c3.index }, "SIGNOFF"); await s.sendAid("Enter", { cursor: { row: c3.row, col: c3.col }, timeoutMs: 10000 }).catch(() => {}); }
  await sleep(500);
  s.disconnect();
  log(`RESULT: pass=${pass} fail=${fail}`);
  process.exit(fail > 0 ? 1 : 0);
}
void s.sendAid("Enter", { cursor: { row: cmd.row, col: cmd.col }, timeoutMs: 20000 }).catch(() => {});
await sleep(2500);
s.setSysReqLine(true); // 画面の側で SysReq の行を出した
await sleep(9000); // LATE が届く
log(`  行を出している間の 5 行目: ${JSON.stringify(row(s, 5))}`);
// 「空」だけだと LATE がまだ届いていなくても通る——止めたレコードが溜めにあることも見る（届いて止めた、の裏づけ）
check(s.hostHeld.length > 0, `LATE は届いて溜めにある（${s.hostHeld.length} 本）`);
check(row(s, 5) === "", "行を出している間は LATE を出さない（ACS と同じ）");
if (ARG === "SUBMIT") {
  // 別の経路: 行から SysReq を送って閉じる（ACS のコア `scripts/acs-probe/sysreq-line-hold-submit.txt`）。ホストはシステム要求のメニューを出す
  await s.sendAid("SysReq", { sysReqText: "", timeoutMs: 15000 }).catch(() => {});
  await sleep(2000);
  log(`  SysReq を送った後: 行=${s.snapshot().sysReqLine === true} 1 行目=${JSON.stringify(row(s, 1))}`);
  check(s.snapshot().sysReqLine !== true && s.hostHeld.length === 0, "SysReq を送ると行を閉じて溜めを流す");
  await s.sendAid("F12", { timeoutMs: 15000 }).catch(() => {}); // メニューから戻る（ホストが元の画面を戻す）
  await sleep(2000);
  log(`  メニューから戻った後の 5 行目: ${JSON.stringify(row(s, 5))}`);
  check(row(s, 5) === "LATE", "戻った画面に LATE がある（ACS と同じ）");
} else {
  s.setSysReqLine(false); // Reset で閉じた
  await sleep(500);
  log(`  閉じた後の 5 行目: ${JSON.stringify(row(s, 5))}`);
  check(row(s, 5) === "LATE", "閉じたら LATE が出る（ACS と同じ）");
}
const r = await s.sendAid("Enter", { cursor: { row: 7, col: 10 }, timeoutMs: 15000 }).catch((e) => ({ err: String(e) }));
check(!r.err && !r.timedOut, "その後の Enter がホストの READ に届いて画面が戻る");
await sleep(1500);
const c2 = inputs(s).find((x) => x.length >= 50);
if (c2) { s.setField({ index: c2.index }, "SIGNOFF"); await s.sendAid("Enter", { cursor: { row: c2.row, col: c2.col }, timeoutMs: 10000 }).catch(() => {}); }
await sleep(500);
s.disconnect();
log(`RESULT: pass=${pass} fail=${fail}`);
process.exit(fail > 0 ? 1 : 0);
