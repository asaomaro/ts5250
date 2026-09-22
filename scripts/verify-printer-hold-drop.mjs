// 実機検証（tn5250）: **帳票の応答を止めている間に接続が切れたら、ホストはスプールをどうするか。繋ぎ直すと送り直すか**
// （`20260921-printer-hold-response` の独立点検の指摘。research F3 は「止めている間は WTR のまま・応答すると消える」までしか測っていない）。
//
// 手順（PUB400。SBCS の 3812）:
//   1) プリンター A を開き、帳票の応答を止めたままにする → スプールの状態（WTR のはず）
//   2) A を切断する → 10 秒後・30 秒後のスプールの状態
//   3) 同じ装置名でプリンター B を開き（止めない）、用紙の問い合わせに答えながら送り直されるかを待つ → スプールの状態
// **スプールは最後に消す**（DLTSPLF）。装置は PUB400 が切断後も持つので、ほかの検証スクリプトと同じく毎回別の名前にする。
//
// 実行: node --env-file=.env --env-file=.env.verify scripts/verify-printer-hold-drop.mjs
//   env: PUB400_USER / PUB400_PASSWORD（任意 PUB400_HOST）
import { PrinterSession, Session5250 } from "@ts5250/tn5250";

const HOST = process.env.PUB400_HOST ?? "pub400.com";
const USER = process.env.PUB400_USER;
const PW = process.env.PUB400_PASSWORD;
if (!USER || !PW) { process.stderr.write("PUB400_USER / PUB400_PASSWORD が要ります（.env）\n"); process.exit(2); }
const PRTDEV = "VD" + String(Date.now() % 100000).padStart(5, "0");
const log = (s) => process.stderr.write(`${s}\n`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rows = (snap) => snap.cells.map((r) => r.map((c) => c.char).join("").replace(/\s+$/, ""));
const inputs = (snap) => snap.fields.filter((f) => !f.protected);

async function display() {
  const s = await Session5250.connect({ host: HOST, ccsid: 37 });
  await sleep(800);
  const [u, p] = inputs(s.snapshot());
  s.setField({ index: u.index }, USER);
  s.setField({ index: p.index }, PW);
  await s.sendAid("Enter", { cursor: { row: u.row, col: u.col }, timeoutMs: 15000 });
  for (let i = 0; i < 5; i++) {
    await sleep(800);
    if (rows(s.snapshot()).some((r) => /===>/.test(r))) break;
    await s.sendAid("Enter", { timeoutMs: 10000 }).catch(() => {});
  }
  return s;
}
async function cmd(s, text) {
  const f = inputs(s.snapshot()).find((x) => x.length >= 50) ?? inputs(s.snapshot()).slice(-1)[0];
  s.setField({ index: f.index }, text);
  await s.sendAid("Enter", { cursor: { row: f.row, col: f.col }, timeoutMs: 20000 }).catch(() => {});
  await sleep(1200);
  return rows(s.snapshot());
}
const back = async (s) => { await s.sendAid("F3", { timeoutMs: 10000 }).catch(() => {}); await sleep(800); };
/** 待ち行列の QPRTLIBL の行の状態（無ければ "(無し)"）。用紙の問い合わせ（MSGW）には I で答える */
async function spoolState(s, answer = false) {
  const t = await cmd(s, `WRKOUTQ OUTQ(${PRTDEV})`);
  const i = t.findIndex((r) => r.includes("QPRTLIBL"));
  let state = i < 0 ? "(無し)" : (t[i].trim().split(/\s+/).find((w) => /^(RDY|WTR|PND|SND|HLD|MSGW|SAV|WRT|OPN|CLO|DFR|FIN)$/.test(w)) ?? "?");
  if (answer && i >= 0 && t[i].includes("MSGW")) {
    const opt = inputs(s.snapshot()).filter((f) => f.row === i + 1).sort((a, b) => a.col - b.col)[0];
    s.setField({ index: opt.index }, "7");
    await s.sendAid("Enter", { cursor: { row: opt.row, col: opt.col }, timeoutMs: 15000 }).catch(() => {});
    const reply = inputs(s.snapshot()).sort((a, b) => b.row - a.row || b.col - a.col)[0];
    s.setField({ index: reply.index }, "I");
    await s.sendAid("Enter", { cursor: { row: reply.row, col: reply.col }, timeoutMs: 15000 }).catch(() => {});
    state = "MSGW→I";
    await back(s);
  }
  await back(s);
  return state;
}

let heldReports = 0;
const a = await PrinterSession.connect({
  host: HOST, port: 23, deviceName: PRTDEV, user: USER, password: PW,
  respondAfter: () => { heldReports++; return new Promise(() => {}); } // 応答しない
});
log(`プリンター A 起動: ${a.startupCode}`);
const s = await display();
let b;
try {
  await cmd(s, `CHGJOB OUTQ(${PRTDEV})`);
  await cmd(s, "DSPLIBL OUTPUT(*PRINT)");
  await sleep(2000);
  for (let i = 0; i < 4 && heldReports < 1; i++) { log(`届く前 ${await spoolState(s, true)}`); await sleep(3000); }
  log(`A: 帳票が届いた=${heldReports >= 1}（応答を止めている）`);
  await sleep(5000);
  log(`A: 止めて 5 秒: スプール=${await spoolState(s)}`);
  a.disconnect();
  await sleep(10000);
  log(`A を切断して 10 秒: スプール=${await spoolState(s)}`);
  await sleep(20000);
  log(`A を切断して 30 秒: スプール=${await spoolState(s)}`);
  let got = 0;
  for (let i = 0; i < 12 && !b; i++) {
    try {
      b = await PrinterSession.connect({ host: HOST, port: 23, deviceName: PRTDEV, user: USER, password: PW });
    } catch (e) {
      log(`B の接続 ${i + 1} 回目: ${/\b\d{4}\b/.exec(String(e?.message))?.[0] ?? "失敗"}`);
      await sleep(10000);
    }
  }
  if (b) {
    log(`プリンター B 起動: ${b.startupCode}`);
    b.on("report", () => { got++; });
    // 書き出しプログラムは起動のたびに用紙の問い合わせ（MSGW）で止まる（1 回目の実測）。答えながら待つ
    for (let i = 0; i < 8 && got === 0; i++) { log(`B: 待ち ${await spoolState(s, true)}`); await sleep(4000); }
    log(`B: 送り直された帳票=${got}`);
    await sleep(3000);
    log(`B: スプール=${await spoolState(s)}`);
  }
} finally {
  log("--- 片付け ---");
  for (let i = 0; i < 3; i++) await cmd(s, "DLTSPLF FILE(QPRTLIBL) JOB(*) SPLNBR(*LAST)");
  await cmd(s, "SIGNOFF");
  s.disconnect();
  a.disconnect();
  b?.disconnect();
}
process.exit(0);
