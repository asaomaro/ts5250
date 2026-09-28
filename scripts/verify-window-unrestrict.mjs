// 実機検証（tn5250）: **WDSF 0x52（窓のカーソル制限の解除）を ACS と同じに受けるか**（`20260928-window-unrestrict`）。
//
// 前提: `DSCMD_LIB=<AS400_LIB> node --env-file=.env --env-file=.env.verify scripts/build-dscmd.mjs`（`scripts/host-src/dscmd.c` の WINRESTRICT / WINUNRESTRICT / WINUNRESTRICTBAD）。
// ACS のコア（`scripts/acs-probe/window-unrestrict.txt`。ENPTUI を申告）: 制限つきの窓は矢印が窓の中を回り、0x52 の後は窓の外へ出た。中身 3 バイトの 0x52 は
// 否定応答（ホストの次の読みが CPFA304）。当 PJ はカーソルの制限を画面の側が行うので、ここでは画面の写しの `restrictCursor` と否定応答を見る。
// **終わったら DLTPGM と IFS の /tmp/dscmd.c・/tmp/dscmd.log を消す**。
//
// 実行: node --env-file=.env --env-file=.env.verify scripts/verify-window-unrestrict.mjs
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
const run = async (mode) => {
  const cmd = inputs(s).find((f) => f.length >= 50);
  if (!cmd) throw new Error("コマンド行が出ない");
  s.setField({ index: cmd.index }, `CALL ${LIB}/DSCMD PARM('${mode}')`);
  void s.sendAid("Enter", { cursor: { row: cmd.row, col: cmd.col }, timeoutMs: 20000 }).catch(() => {});
  await sleep(4000);
  const wins = s.snapshot().gui?.windows ?? [];
  // 抜ける（READ MDT で待っている。BAD は既に抜けている）
  if (!inputs(s).some((f) => f.length >= 50)) { await s.sendAid("Enter", { cursor: { row: 7, col: 14 }, timeoutMs: 10000 }).catch(() => {}); await sleep(2500); }
  return wins.map((w) => w.restrictCursor);
};
const readLog = async () => {
  const ifs = await IfsConnection.connect({ host: process.env.AS400_HOST, user: process.env.AS400_USER, password: process.env.AS400_PASSWORD });
  const t = await ifs.readTextFile("/tmp/dscmd.log");
  const bytes = t?.data ?? t;
  ifs.close?.();
  return typeof bytes === "string" ? bytes : codecForCcsid(t?.ccsid ?? 37).decode(Uint8Array.from(Object.values(bytes)));
};
const r = await run("WINRESTRICT");
check(JSON.stringify(r) === "[true]", `制限つきの窓は制限のまま（${JSON.stringify(r)}）`);
const un = await run("WINUNRESTRICT");
check(JSON.stringify(un) === "[false]", `0x52 の後は制限が外れる（${JSON.stringify(un)}）`);
await run("WINUNRESTRICTBAD");
const text = await readLog();
check(/QsnReadMDT rc=-1 .*CPFA304/.test(text), "中身 3 バイトの 0x52 は否定応答（ホストの次の読みが CPFA304。ACS と同じ）");
const c2 = inputs(s).find((f) => f.length >= 50);
if (c2) { s.setField({ index: c2.index }, "SIGNOFF"); await s.sendAid("Enter", { cursor: { row: c2.row, col: c2.col }, timeoutMs: 10000 }).catch(() => {}); }
await sleep(500);
s.disconnect();
log(`RESULT: pass=${pass} fail=${fail}`);
process.exit(fail > 0 ? 1 : 0);
