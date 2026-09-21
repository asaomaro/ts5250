// **ホストの妥当性検査エラー（全画面・窓）**を当 PJ（コア）がどう受け、どう見せるかを実機で測る。
//
// `scripts/acs-probe/window-error.txt` と同じ操作。ULKPGM の RANGE（全画面）と WINDOW（窓）に範囲外の 9 を入れる。
// 届いたレコードの 5250 コマンド（WRITE ERROR CODE 0x21 / TO WINDOW 0x22 / WTD 0x11）と、
// 画面（最下行・窓の中）・`systemMessage` を出す。
//
// 実行: node --env-file=.env --env-file=.env.verify scripts/verify-host-error.mjs
import { Session5250 } from "@ts5250/tn5250";

const host = process.env.AS400_HOST, user = process.env.AS400_USER, password = process.env.AS400_PASSWORD;
const LIB = process.env.AS400_LIB ?? "TESTLIB";
if (!host || !user || !password) { process.stderr.write("AS400_HOST / AS400_USER / AS400_PASSWORD が要ります（.env）\n"); process.exit(2); }
const ccsid = Number(process.env.AS400_CCSID ?? 930);
const log = (s) => process.stderr.write(`${s}\n`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rows = (snap) => snap.cells.map((r) => r.map((c) => c.char).join("").replace(/\s+$/, ""));
const inputsOf = (snap) => snap.fields.filter((f) => !f.protected);
/** 受信レコードの ESC に続くコマンドバイトを並べる（トレースの hex から） */
const cmds = [];
const s = await Session5250.connect({
  host, ccsid, traceRecords: true,
  warn: (m) => {
    const hex = /([0-9a-f]{2}( [0-9a-f]{2})+)/.exec(m)?.[1];
    if (!hex) return;
    const b = hex.split(" ").map((x) => parseInt(x, 16));
    const found = [];
    for (let i = 0; i + 1 < b.length; i++) if (b[i] === 0x04 && [0x11, 0x21, 0x22, 0x40, 0x42, 0x52].includes(b[i + 1])) found.push(b[i + 1].toString(16));
    if (found.length) cmds.push(found.join(","));
  }
});
await sleep(800);
let inputs = inputsOf(s.snapshot());
s.setField({ index: inputs[0].index }, user);
s.setField({ index: inputs[1].index }, password);
await s.sendAid("Enter", { cursor: { row: inputs[0].row, col: inputs[0].col }, timeoutMs: 15000 });
for (let i = 0; i < 6; i++) {
  await sleep(800);
  const t = rows(s.snapshot());
  if (t.some((r) => /===>/.test(r))) break;
  if (t.some((r) => r.includes("対話式ジョブの回復"))) {
    const f = inputsOf(s.snapshot()).slice(-1)[0];
    s.setField({ index: f.index }, "90");
    await s.sendAid("Enter", { cursor: { row: f.row, col: f.col }, timeoutMs: 12000 });
  } else await s.sendAid("Enter", { timeoutMs: 10000 });
}
async function scenario(mode) {
  const cmd = inputsOf(s.snapshot()).find((f) => f.length >= 50);
  s.setField({ index: cmd.index }, `CALL ${LIB}/ULKPGM PARM('${mode}')`);
  await s.sendAid("Enter", { cursor: { row: cmd.row, col: cmd.col }, timeoutMs: 15000 });
  await sleep(1500);
  const f = inputsOf(s.snapshot()).find((x) => x.length <= 2);
  if (!f) {
    log(`[${mode}] 欄が見つからない: ${inputsOf(s.snapshot()).map((x) => `${x.row},${x.col}/${x.length}`).join(" ")} | ${rows(s.snapshot())[0]}`);
    return;
  }
  cmds.length = 0;
  s.setField({ index: f.index }, "9");
  await s.sendAid("Enter", { cursor: { row: f.row, col: f.col }, timeoutMs: 15000 });
  await sleep(1500);
  const snap = s.snapshot();
  log(`[${mode}] commands in reply: ${cmds.join(" | ")}`);
  log(`[${mode}] systemMessage=${JSON.stringify(snap.systemMessage ?? null)} keyboardLocked=${snap.keyboardLocked} cursor=${snap.cursor.row},${snap.cursor.col}`);
  rows(snap).forEach((r, i) => { if (r.trim() && (i >= 5 || i === 0)) log(`  ${String(i + 1).padStart(2, "0")}|${r}`); });
  await s.sendAid("F3", { timeoutMs: 10000 }).catch(() => {});
  await sleep(1000);
}
await scenario("RANGE");
await scenario("WINDOW");
const c2 = inputsOf(s.snapshot()).find((f) => f.length >= 50);
if (c2) { s.setField({ index: c2.index }, "SIGNOFF"); await s.sendAid("Enter", { timeoutMs: 10000 }).catch(() => {}); }
s.disconnect();
