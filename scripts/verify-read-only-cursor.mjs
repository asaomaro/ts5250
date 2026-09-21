// **READ だけのレコード（WTD 無し）で当 PJ がカーソルを動かすか**を実機で測る（ACS との突き合わせ）。
//
// `scripts/acs-probe/read-only-cursor.txt` と同じ操作——WRKOBJ の一覧でコマンド行（21,7）から QSH を起動し、
// F3 で戻ったときのカーソルを見る。QSH の出口は `RESTORE SCREEN`＋`READ MDT` の 1 レコード（WTD 無し）。
// ACS は 21,7（コマンド行）のまま。当 PJ は READ で先頭の入力欄（8,2）へ動かしていないか。
//
// 実行: node --env-file=.env --env-file=.env.verify scripts/verify-read-only-cursor.mjs
//   AS400_HOST / AS400_USER / AS400_PASSWORD（`.env`）。資格情報は出力しない。
import { Session5250 } from "@ts5250/tn5250";

const host = process.env.AS400_HOST, user = process.env.AS400_USER, password = process.env.AS400_PASSWORD;
if (!host || !user || !password) { process.stderr.write("AS400_HOST / AS400_USER / AS400_PASSWORD が要ります（.env）\n"); process.exit(2); }
const ccsid = Number(process.env.AS400_CCSID ?? 930);
const log = (s) => process.stderr.write(`${s}\n`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rows = (snap) => snap.cells.map((r) => r.map((c) => c.char).join("").replace(/\s+$/, ""));
const inputsOf = (snap) => snap.fields.filter((f) => !f.protected);
const cur = (s) => { const c = s.snapshot().cursor; return `${c.row},${c.col}`; };

const s = await Session5250.connect({ host, ccsid, warn: () => {} });
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
const cmdLine = () => inputsOf(s.snapshot()).find((f) => f.length >= 50);
let c = cmdLine();
s.setField({ index: c.index }, "WRKOBJ OBJ(QSYS/QCMD*) OBJTYPE(*PGM)");
await s.sendAid("Enter", { cursor: { row: c.row, col: c.col }, timeoutMs: 15000 });
await sleep(1500);
log(`list: cursor=${cur(s)} ${rows(s.snapshot())[0].trim()}`);
c = cmdLine();
s.setField({ index: c.index }, "QSH");
await s.sendAid("Enter", { cursor: { row: c.row, col: c.col + 3 }, timeoutMs: 15000 });
await sleep(2500);
log(`in-qsh: cursor=${cur(s)} ${rows(s.snapshot())[0].trim()}`);
await s.sendAid("F3", { timeoutMs: 15000 });
await sleep(2500);
log(`back-from-qsh: cursor=${cur(s)} ${rows(s.snapshot())[0].trim()}`);
await s.sendAid("F3", { timeoutMs: 10000 }).catch(() => {});
await sleep(1000);
c = cmdLine();
if (c) { s.setField({ index: c.index }, "SIGNOFF"); await s.sendAid("Enter", { timeoutMs: 10000 }).catch(() => {}); }
s.disconnect();
