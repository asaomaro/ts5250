// 実機検証（HLLAPI）: **打ったまま欄を出ていない右寄せ・符号付き数値の欄から AID を送らない（ACS のエラー 0x20）**（`20260928-hllapi-exit-required`）。
//
// ACS のコア（`scripts/acs-probe/exit-required-aid.txt`・`exit-required-aid-arrow.txt`。DSM の EXITREQ）で測った場合を、当 PJ の HLLAPI（dist の `callHllapi`）で同じ手順にして
// `rc` と、送れたか（ホストが次の巡の画面を出したか）を比べる。ACS: RZ に打って Enter・同じ欄の中へ Set Cursor・別の欄を経て Set Cursor・右の矢印・符号付き数値は止まる、Tab・Backtab で着き直せば送れる。
//
// 前提: npm run build ／ DSCMD_LIB=<AS400_LIB> node --env-file=.env --env-file=.env.verify scripts/build-dscmd.mjs
// 実行: node --env-file=.env --env-file=.env.verify scripts/verify-hllapi-exit-required.mjs
// **終わったら DLTPGM と IFS の /tmp/dscmd.c・/tmp/dscmd.log を消す**。
import { Session5250 } from "@ts5250/tn5250";
import { callHllapi, HllapiState } from "../packages/server/dist/hllapi.js";

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
s.setField({ index: cmd.index }, `CALL ${LIB}/DSCMD PARM('EXITREQ')`);
await s.sendAid("Enter", { cursor: { row: cmd.row, col: cmd.col }, timeoutMs: 15000 }).catch(() => {});
await sleep(2500);

const entry = { id: "v", connectedAt: new Date().toISOString(), host: "h", session: s };
const sessions = {
  list: () => [entry], get: () => entry,
  assertKeyAllowed: () => undefined, assertWritable: () => undefined,
  reserve: () => undefined, release: () => undefined, touchReservation: () => undefined, reservationOf: () => undefined
};
const deps = { sessions, state: new HllapiState() };
const call = (fn, data = "", pos = 0) => callHllapi(deps, { function: fn, dataB64: Buffer.from(data, "latin1").toString("base64"), length: data.length, pos });
const at = (row, col) => (row - 1) * s.snapshot().cols + col;
if ((await call(1, "A")).rc !== 0) { log("Connect に失敗"); process.exit(1); }
/** 巡の画面の印（打つ前に消えている＝ホストが次の巡を出した） */
const typedRz = () => s.snapshot().fields.find((f) => f.row === 3 && f.col === 10)?.value.trim() ?? "";

// [名前, 手順（set=Set Cursor / key=SendKey）, 期待の rc, ACS で送れたか]
const CASES = [
  ["E1 RZ に 12 → @E", [["set", 3, 10], ["key", "12@E"]], 5, false],
  ["E2 同じ欄の中へ Set Cursor → @E", [["set", 3, 10], ["key", "12"], ["set", 3, 11], ["key", "@E"]], 5, false],
  ["E3 別の欄を経て Set Cursor → @E", [["set", 3, 10], ["key", "12"], ["set", 7, 10], ["set", 3, 12], ["key", "@E"]], 5, false],
  ["E4 Tab・Backtab で着き直す → @E", [["set", 3, 10], ["key", "12@T@B@E"]], 0, true],
  ["E5 符号付き数値に 12 → @E", [["set", 5, 10], ["key", "12@E"]], 5, false],
  ["E6a 右の矢印 → @E", [["set", 3, 10], ["key", "12@Z@E"]], 5, false]
];
for (const [name, steps, wantRc, wantSent] of CASES) {
  let rc = 0;
  for (const [op, a, b] of steps) {
    const r = op === "set" ? await call(40, "", at(a, b)) : await call(3, a);
    rc = r.rc;
  }
  await sleep(2000);
  const sent = typedRz() === "" && s.snapshot().fields.find((f) => f.row === 5 && f.col === 10)?.value.trim() === "";
  check(rc === wantRc, `${name}: rc=${rc}（期待 ${wantRc}）`);
  check(sent === wantSent, `${name}: ${sent ? "送った" : "送らなかった"}（ACS: ${wantSent ? "送れた" : "止まった"}）`);
  // 止まった巡は素の欄から Enter で次の巡へ（ACS の probe と同じ）
  if (!sent) {
    await s.sendAid("Enter", { cursor: { row: 7, col: 10 }, timeoutMs: 15000 }).catch(() => {});
    await sleep(2500);
  }
}
await sleep(1000);
const c2 = inputs(s).find((f) => f.length >= 50);
if (c2) { s.setField({ index: c2.index }, "SIGNOFF"); await s.sendAid("Enter", { timeoutMs: 10000 }).catch(() => {}); }
s.disconnect();
log(`RESULT: pass=${pass} fail=${fail}`);
process.exit(fail > 0 ? 1 : 0);
