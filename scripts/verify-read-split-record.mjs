// **WTD と READ が別のレコードで来る画面で、当 PJ（コア）がカーソルをどこに置くか**を実機で測る（ACS との突き合わせ）。
//
// `scripts/acs-probe/read-split-record.txt` と同じ操作。`scripts/build-ulktest.mjs` の ULKPGM:
//   SPLIT  — SNDF（2 つ目の欄 7,20 に DSPATR(PC)＝IC）→ RCVF。ACS は 7,20
//   SPLITN — 同じ形で IC なし。ACS は先頭の入力欄 5,20
// 届いたレコードごとの 5250 コマンド（WTD 0x11 / READ MDT 0x52 ほか）も出して、本当に分かれているかを見る。
//
// 実行: node --env-file=.env --env-file=.env.verify scripts/verify-read-split-record.mjs
import { Session5250 } from "@ts5250/tn5250";

const host = process.env.AS400_HOST, user = process.env.AS400_USER, password = process.env.AS400_PASSWORD;
const LIB = process.env.AS400_LIB ?? "TESTLIB";
if (!host || !user || !password) { process.stderr.write("AS400_HOST / AS400_USER / AS400_PASSWORD が要ります（.env）\n"); process.exit(2); }
const ccsid = Number(process.env.AS400_CCSID ?? 930);
const log = (s) => process.stderr.write(`${s}\n`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rows = (snap) => snap.cells.map((r) => r.map((c) => c.char).join("").replace(/\s+$/, ""));
const inputsOf = (snap) => snap.fields.filter((f) => !f.protected);
/** 受信レコードごとの 5250 コマンド（ESC の次のバイト） */
const records = [];
const s = await Session5250.connect({
  host, ccsid, traceRecords: true,
  warn: (m) => {
    const hex = /([0-9a-f]{2}( [0-9a-f]{2})+)/.exec(m)?.[1];
    if (!hex) return;
    const b = hex.split(" ").map((x) => parseInt(x, 16));
    const found = [];
    for (let i = 0; i + 1 < b.length; i++) if (b[i] === 0x04 && [0x11, 0x40, 0x42, 0x52, 0x62, 0x66, 0x72, 0x82, 0x83, 0x12, 0x02].includes(b[i + 1])) found.push(b[i + 1].toString(16));
    if (found.length) records.push(found.join(","));
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
  records.length = 0;
  await s.sendAid("Enter", { cursor: { row: cmd.row, col: cmd.col }, timeoutMs: 15000 });
  await sleep(2500);
  const snap = s.snapshot();
  log(`[${mode}] ${rows(snap)[0].trim()} cursor=${snap.cursor.row},${snap.cursor.col} records=${records.join(" | ")}`);
  await s.sendAid("F3", { timeoutMs: 10000 }).catch(() => {});
  await sleep(1200);
}
await scenario("SPLIT");
await scenario("SPLITN");
const c2 = inputsOf(s.snapshot()).find((f) => f.length >= 50);
if (c2) { s.setField({ index: c2.index }, "SIGNOFF"); await s.sendAid("Enter", { timeoutMs: 10000 }).catch(() => {}); }
s.disconnect();
