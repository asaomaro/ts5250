// 実機検証（server の HLLAPI）: **MF の欄を出る @T・@B・@0 は ACS と同じく止まるか**（`20260927-hllapi-tab-mandatory`）、
// **AID の前の MF・ME は ACS と同じく止まるか**（`20260928-hllapi-aid-checks`。ACS のコアの 9 場合は `scripts/acs-probe/mandatory-me-mf.txt`）。
//
// 画面は ADJPGM（7,20=CHECK(MF) A 6 桁。`scripts/acs-probe/mandatory-me-mf.txt` と同じ。実機にオブジェクトは作らない）。
// ACS のコア（`scripts/acs-probe/hllapi-tab-mandatory.txt`）: AB で Tab → 7,20・入力禁止・後ろの CD は入らない／欄の途中からの Backtab は止まらない／
// 欄頭からの Backtab・Home → 7,20・入力禁止。
// HLLAPI は `callHllapi` を実物のセッションに当てる（共有ライブラリと HTTP は通さない。見るのは `sendKey` の分岐）。
//
// 実行: node --env-file=.env --env-file=.env.verify scripts/verify-hllapi-tab-mandatory.mjs
import { Session5250 } from "@ts5250/tn5250";
// HLLAPI の入口は公開面（`@ts5250/server` の root）に無いので、ビルド済みの実体を直に取る（先に `npm run build`）
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
const command = async (text) => {
  const cmd = inputs(s).find((f) => f.length >= 50);
  if (!cmd) throw new Error("コマンド行が出ない");
  s.setField({ index: cmd.index }, text);
  await s.sendAid("Enter", { cursor: { row: cmd.row, col: cmd.col }, timeoutMs: 15000 }).catch(() => {});
  await sleep(1500);
};
await command(`ADDLIBLE ${LIB}`);

// HLLAPI の依存を実物のセッション 1 本で組む（予約・権限は素通し）
const entry = { id: "v", connectedAt: new Date().toISOString(), host: "h", session: s };
const sessions = {
  list: () => [entry],
  get: () => entry,
  assertKeyAllowed: () => undefined,
  assertWritable: () => undefined,
  reserve: () => undefined,
  release: () => undefined,
  touchReservation: () => undefined,
  reservationOf: () => undefined
};
const deps = { sessions, state: new HllapiState() };
const call = (fn, data = "", pos = 0) =>
  callHllapi(deps, { function: fn, dataB64: Buffer.from(data, "latin1").toString("base64"), length: data.length, pos });
const at = (row, col) => (row - 1) * s.snapshot().cols + col;
const mfValue = () => s.snapshot().fields.find((f) => f.row === 7 && f.col === 20)?.value ?? "";
const conn = await call(1, "A");
if (conn.rc !== 0) { log(`Connect rc=${conn.rc}`); process.exit(1); }

const cases = [
  { name: "AB@TCD", from: [7, 20], keys: "AB@TCD", rc: 5, value: "AB" },
  { name: "AB@B（欄の途中から）", from: [7, 20], keys: "AB@B", rc: 0, value: "AB" },
  { name: "欄頭から @B", from: [7, 20], keys: "AB", then: [7, 20], keys2: "@B", rc: 5, value: "AB" },
  { name: "AB@0", from: [7, 20], keys: "AB@0", rc: 5, value: "AB" }
];
for (const c of cases) {
  await command(`CALL ${LIB}/ADJPGM`);
  await sleep(1000);
  await call(40, "", at(...c.from));
  let r = await call(3, c.keys);
  if (c.then) { await call(40, "", at(...c.then)); r = await call(3, c.keys2); }
  log(`  ${c.name}: rc=${r.rc} 値=${JSON.stringify(mfValue())}`);
  check(r.rc === c.rc, `${c.name} の rc=${c.rc}`);
  check(mfValue().trim() === c.value, `${c.name} の後の MF 欄は ${c.value}（止まった後ろの字は入らない）`);
  // **カーソルの位置は次に打つ字の行き先で見る**（Query Cursor Location はホスト側のカーソルを返す）。欄頭 7,20 なら `XB`
  await call(3, "X");
  check(mfValue().trim() === "XB", `${c.name} の後のカーソルは欄頭 7,20（次の字で ${JSON.stringify(mfValue().trim())}）`);
  // 抜ける: 欄を埋めてから F3（CA03。ME 欄も MF も見ない）
  s.setField({ row: 7, col: 20 }, "ABCDEF");
  await s.sendAid("F3", { cursor: { row: 13, col: 20 }, timeoutMs: 10000 }).catch(() => {});
  await sleep(1500);
}
// ---- AID の前の検査（ADJPGM: 7,20=MF / 11,20=ME / 13,20=素の欄 / F3=CA03）----
const valueAt = (row) => s.snapshot().fields.find((f) => f.row === row && f.col === 20)?.value ?? "";
const onAdj = () => s.snapshot().fields.some((f) => f.row === 11 && f.col === 20 && !f.protected);
const aidCases = [
  // ACS 場合 5: MF に AB で Enter → MF エラー・欄頭
  { name: "MF に AB で @E", at: [7, 20], keys: "AB@E", rc: 5, probeRow: 7, probe: "XB", stays: true },
  // ACS 場合 2: 素の欄に打って Enter（ME 空）→ ME エラー・ME 欄へ
  { name: "素の欄に打って @E（ME 空）", at: [13, 20], keys: "Z@E", rc: 5, probeRow: 11, probe: "X", stays: true },
  // ACS 場合 3: 素の欄に打って F3（CA03）→ 送れた
  { name: "素の欄に打って @3（CA03）", at: [13, 20], keys: "Z@3", rc: 0, stays: false },
  // ACS 場合 1: 何も打たずに Enter → 送れた
  { name: "何も打たずに @E", at: [13, 20], keys: "@E", rc: 0 }
];
for (const c of aidCases) {
  await command(`CALL ${LIB}/ADJPGM`);
  await sleep(1000);
  await call(40, "", at(...c.at));
  const r = await call(3, c.keys);
  await sleep(1500);
  log(`  ${c.name}: rc=${r.rc} ADJPGM のまま=${onAdj()}`);
  check(r.rc === c.rc, `${c.name} の rc=${c.rc}`);
  if (c.stays !== undefined) check(onAdj() === c.stays, `${c.name} の後 ${c.stays ? "送らずに ADJPGM のまま" : "送って ADJPGM を抜けた"}`);
  if (c.probe !== undefined) {
    await call(3, "X");
    check(valueAt(c.probeRow).trim() === c.probe, `${c.name} の後のカーソルは ${c.probeRow},20（次の字で ${JSON.stringify(valueAt(c.probeRow).trim())}）`);
  }
  if (onAdj()) {
    s.setField({ row: 7, col: 20 }, "ABCDEF");
    await s.sendAid("F3", { cursor: { row: 13, col: 20 }, timeoutMs: 10000 }).catch(() => {});
    await sleep(1500);
  }
}
await command("SIGNOFF");
s.disconnect();
log(`RESULT: pass=${pass} fail=${fail}`);
process.exit(fail > 0 ? 1 : 0);
