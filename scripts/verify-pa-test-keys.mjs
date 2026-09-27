// 実機検証（tn5250）: **PA1〜PA3 と Test Request**（`20260927-key-edit-rest`）。
//
// 前提: `DSCMD_LIB=<AS400_LIB> node --env-file=.env --env-file=.env.verify scripts/build-dscmd.mjs`（`scripts/host-src/dscmd.c` の JHOME）。
// ACS のコア（`scripts/acs-probe/pa-keys.txt`）: 7,10 に AB を打って PA1 → READ は `07 0c 6c`・PA3 → `07 0c 6b`（欄データ無し）。
// Test Request はヘッダのフラグ 0x02 だけで、ホストは CANCEL INVITE を返す（当 PJ は応答を返してセッションが続く）。
// **モードごとに繋ぎ直す**。**終わったら DLTPGM と IFS の /tmp/dscmd.* を消す**。
//
// 実行: node --env-file=.env --env-file=.env.verify scripts/verify-pa-test-keys.mjs [PA1|PA3|TestRequest …]
import { Session5250 } from "@ts5250/tn5250";
import { IfsConnection } from "@ts5250/hostserver";
import { codecForCcsid } from "@ts5250/ebcdic";

const LIB = (process.env.AS400_LIB ?? "TESTLIB").trim().split(/\s+/)[0];
const ACS = { PA1: "070c6c", PA2: "070c6e", PA3: "070c6b" };
const KEYS = process.argv.slice(2).length ? process.argv.slice(2) : ["PA1", "PA2", "PA3", "TestRequest"];
const log = (s) => process.stderr.write(`${s}\n`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const inputs = (s) => s.snapshot().fields.filter((f) => !f.protected);
let pass = 0, fail = 0;
const check = (c, m) => { if (c) { pass++; log(`  PASS ${m}`); } else { fail++; log(`  FAIL ${m}`); } };
const readLog = async () => {
  const ifs = await IfsConnection.connect({ host: process.env.AS400_HOST, user: process.env.AS400_USER, password: process.env.AS400_PASSWORD });
  const t = await ifs.readTextFile("/tmp/dscmd.log");
  const bytes = t?.data ?? t;
  ifs.close?.();
  return typeof bytes === "string" ? bytes : codecForCcsid(t?.ccsid ?? 37).decode(Uint8Array.from(Object.values(bytes)));
};
for (const key of KEYS) {
  log(`### ${key}`);
  const s = await Session5250.connect({ host: process.env.AS400_HOST, ccsid: 930, warn: () => {} });
  await sleep(1000);
  const [u, p] = inputs(s);
  s.setField({ index: u.index }, process.env.AS400_USER);
  s.setField({ index: p.index }, process.env.AS400_PASSWORD);
  await s.sendAid("Enter", { cursor: { row: u.row, col: u.col }, timeoutMs: 15000 });
  for (let i = 0; i < 4; i++) { await sleep(800); if (inputs(s).some((f) => f.length >= 50)) break; await s.sendAid("Enter", { timeoutMs: 10000 }).catch(() => {}); }
  const cmd = inputs(s).find((f) => f.length >= 50);
  if (!cmd) { check(false, `${key}: コマンド行が出ない`); s.disconnect(); continue; }
  s.setField({ index: cmd.index }, `CALL ${LIB}/DSCMD PARM('JHOME')`);
  await s.sendAid("Enter", { cursor: { row: cmd.row, col: cmd.col }, timeoutMs: 20000 });
  await sleep(1500);
  const f = inputs(s).find((x) => x.row === 7 && x.col === 10);
  if (f) s.setField({ index: f.index }, "AB");
  if (key === "TestRequest") {
    await s.sendAid("TestRequest");
    await sleep(3000);
    const snap = s.snapshot();
    log(`  Test Request の後: エラー=${JSON.stringify(snap.systemMessage ?? null)?.slice(0, 60)} 施錠=${snap.keyboardLocked}`);
    check(snap.systemMessage !== undefined, "Test Request にホストが応えた（エラーのメッセージ。ACS も同じ）");
    s.dismissHostError?.();
    await s.sendAid("Enter", { cursor: { row: 7, col: 12 }, timeoutMs: 15000 }).catch(() => {});
  } else {
    await s.sendAid(key, { cursor: { row: 7, col: 12 }, timeoutMs: 15000 }).catch(() => {});
  }
  await sleep(2000);
  const c2 = inputs(s).find((x) => x.length >= 50);
  if (c2) { s.setField({ index: c2.index }, "SIGNOFF"); await s.sendAid("Enter", { cursor: { row: c2.row, col: c2.col }, timeoutMs: 10000 }).catch(() => {}); }
  await sleep(500);
  s.disconnect();
  const dta = /\[READ\] QsnRtvDta len=\d+ hex=([0-9a-f]*)/.exec(await readLog())?.[1];
  log(`  READ が受けた: ${dta}`);
  if (key in ACS) check(dta === ACS[key], `${key}: ACS と同じ ${ACS[key]}`);
  else check(dta === "070cf111070ac1c2", "Test Request の後も続けて打てる（Enter と AB が READ に届く。ACS と同じ）");
  await sleep(1500);
}
log(`RESULT: pass=${pass} fail=${fail}`);
process.exit(fail > 0 ? 1 : 0);
