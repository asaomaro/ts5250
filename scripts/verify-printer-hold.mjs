// 実機検証（tn5250）: **帳票の応答を止めている間、ホストはスプールを残して待つか**（`20260921-printer-hold-response`）。
//
// ACS は印刷先へ書けないと応答を止め、利用者の再試行・取消を待つ（`PSNVT5250P.processPrinterError`）。
// 当 PJ も出力（PDF・自動印刷）に失敗したら応答を止める。その前提——**応答が来るまでホストはスプールを印刷済みにしない**——を測る。
//
// 手順（PUB400。SBCS の 3812）:
//   A) 1 本目の帳票の応答を 30 秒止める → その間のスプールの状態 → 応答する → しばらく後のスプールの状態
//   B) 2 本目の帳票の応答を止めたまま、書き出しプログラムを ENDWTR *IMMED で止める → スプールの状態・接続が切れるか → 応答する
// **スプールは最後に消す**（DLTSPLF）。装置は PUB400 が切断後も持つので、ほかの検証スクリプトと同じく毎回別の名前にする。
//
// 実行: node --env-file=.env --env-file=.env.verify scripts/verify-printer-hold.mjs
//   env: PUB400_USER / PUB400_PASSWORD（任意 PUB400_HOST）
import { PrinterSession, Session5250 } from "@ts5250/tn5250";

const HOST = process.env.PUB400_HOST ?? "pub400.com";
const USER = process.env.PUB400_USER;
const PW = process.env.PUB400_PASSWORD;
if (!USER || !PW) { process.stderr.write("PUB400_USER / PUB400_PASSWORD が要ります（.env）\n"); process.exit(2); }
const PRTDEV = "VH" + String(Date.now() % 100000).padStart(5, "0");
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
  // 行の中の状態の語（RDY・WTR・PND・SND・HLD・MSGW・SAV ほか）を拾う（列の位置は画面の版で動くので決め打ちしない）
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

let release = () => {};
let reports = 0;
let closed = "";
const prt = await PrinterSession.connect({
  host: HOST, port: 23, deviceName: PRTDEV, user: USER, password: PW,
  respondAfter: () => new Promise((resolve) => { reports++; release = resolve; })
});
prt.on("closed", (r) => { closed = String(r); });
log(`プリンター起動: ${prt.startupCode}`);
const s = await display();
try {
  await cmd(s, `CHGJOB OUTQ(${PRTDEV})`);
  // ---- A ----
  await cmd(s, "DSPLIBL OUTPUT(*PRINT)");
  await sleep(2000);
  for (let i = 0; i < 4 && reports < 1; i++) { log(`A: 届く前 ${await spoolState(s, true)}`); await sleep(3000); }
  log(`A: 帳票が届いた=${reports >= 1}（応答を止めている）`);
  for (const t of [5, 30]) { await sleep(t === 5 ? 5000 : 25000); log(`A: 応答を止めて ${t} 秒: スプール=${await spoolState(s)} 接続=${closed || "繋がったまま"}`); }
  release();
  await sleep(5000);
  log(`A: 応答して 5 秒: スプール=${await spoolState(s)}`);
  // ---- B ----
  await cmd(s, "DSPLIBL OUTPUT(*PRINT)");
  await sleep(2000);
  for (let i = 0; i < 4 && reports < 2; i++) { log(`B: 届く前 ${await spoolState(s, true)}`); await sleep(3000); }
  log(`B: 帳票が届いた=${reports >= 2}（応答を止めている）`);
  // PUB400 では書き出しプログラムを止める権限が無い（CPF3330 系）。止められたかどうかをメッセージ ID で出す
  const e = await cmd(s, `ENDWTR WTR(${PRTDEV}) OPTION(*IMMED)`);
  log(`B: ENDWTR *IMMED → ${/CP[FA]\d{4}/.exec(e.join("\n"))?.[0] ?? (/Not authorized/.test(e.join("\n")) ? "権限なし" : "受け付けた")}`);
  await sleep(10000);
  log(`B: ENDWTR の 10 秒後: スプール=${await spoolState(s)} 接続=${closed || "繋がったまま"}`);
  release();
  await sleep(5000);
  log(`B: 応答して 5 秒: スプール=${await spoolState(s)} 接続=${closed || "繋がったまま"}`);
} finally {
  log("--- 片付け ---");
  await cmd(s, `ENDWTR WTR(${PRTDEV}) OPTION(*IMMED)`);
  for (let i = 0; i < 3; i++) await cmd(s, "DLTSPLF FILE(QPRTLIBL) JOB(*) SPLNBR(*LAST)");
  await cmd(s, "SIGNOFF");
  s.disconnect();
  prt.disconnect();
}
process.exit(0);
