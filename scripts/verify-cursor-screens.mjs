// **いくつもの画面で、当 PJ（コア）がカーソルをどこに置くか**を実機で測る（`scripts/acs-probe/cursor-screens.txt` と
// 同じ順）。ACS との突き合わせ用（`20260921-cursor-per-wtd-acs`）。各画面のカーソルと、届いたレコードごとの
// 5250 コマンドを出す。
//
// 実行: node --env-file=.env --env-file=.env.verify scripts/verify-cursor-screens.mjs
import { Session5250 } from "@ts5250/tn5250";

const host = process.env.AS400_HOST, user = process.env.AS400_USER, password = process.env.AS400_PASSWORD;
const LIB = process.env.AS400_LIB ?? "TESTLIB";
if (!host || !user || !password) { process.stderr.write("AS400_HOST / AS400_USER / AS400_PASSWORD が要ります（.env）\n"); process.exit(2); }
const ccsid = Number(process.env.AS400_CCSID ?? 930);
const log = (s) => process.stderr.write(`${s}\n`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rows = (snap) => snap.cells.map((r) => r.map((c) => c.char).join("").replace(/\s+$/, ""));
const inputsOf = (snap) => snap.fields.filter((f) => !f.protected);
const records = [];
const s = await Session5250.connect({
  host, ccsid, traceRecords: true,
  warn: (m) => {
    const hex = /([0-9a-f]{2}( [0-9a-f]{2})+)/.exec(m)?.[1];
    if (!hex) return;
    const b = hex.split(" ").map((x) => parseInt(x, 16));
    const found = [];
    for (let i = 0; i + 1 < b.length; i++) if (b[i] === 0x04 && [0x11, 0x20, 0x40, 0x50, 0x42, 0x52, 0x82, 0x12, 0x02, 0x21].includes(b[i + 1])) found.push(b[i + 1].toString(16));
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
const show = (name) => { const c = s.snapshot().cursor; log(`=== ${name} cursor=${c.row},${c.col} records=${records.join(" | ")}`); records.length = 0; };
async function cmd(text, aid = "Enter", wait = 2500) {
  const f = inputsOf(s.snapshot()).find((x) => x.length >= 50) ?? inputsOf(s.snapshot()).slice(-1)[0];
  s.setField({ index: f.index }, text);
  records.length = 0;
  await s.sendAid(aid, { cursor: { row: f.row, col: f.col }, timeoutMs: 15000 }).catch(() => {});
  await sleep(wait);
}
async function key(aid, wait = 1500) { records.length = 0; await s.sendAid(aid, { timeoutMs: 10000 }).catch(() => {}); await sleep(wait); }
show("main");
await cmd(`DSPFMT FILE(${LIB}/COMPLIST) OUTPUT(*)`, "Enter", 3000); show("dspfmt");
await key("F3"); await key("F12"); show("after-dspfmt");
await cmd("WRKOBJ OBJ(QSYS/QCMD*) OBJTYPE(*PGM)"); show("wrkobj");
await key("F3");
await cmd("SNDMSG", "F4", 2000); show("sndmsg-prompt");
await key("F12");
await cmd("WRKSPLF"); show("wrksplf");
await key("F3");
await cmd(`CALL ${LIB}/ULKPGM PARM('SPLIT')`); show("split");
await key("F3");
await cmd(`CALL ${LIB}/ULKPGM PARM('SPLITN')`); show("splitn");
await key("F3");
await cmd(`CALL ${LIB}/ULKPGM PARM('WINDOW')`); show("window");
await key("F3");
await cmd("SIGNOFF").catch(() => {});
s.disconnect();
