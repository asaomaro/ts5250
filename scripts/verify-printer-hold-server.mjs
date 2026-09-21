// 実機検証（server）: **自動出力に失敗したら応答を止め、再試行で出力できたら応答する**（`20260921-printer-hold-response`）。
//
// サーバーの `SessionManager` でプリンターを開く（自動 PDF の保存先は**まだ無いディレクトリ**）→ 帳票を送る →
// PDF が書けずに応答を止めている間、スプールがホストに残る（WTR）→ 保存先を作って再試行 → PDF ができ、スプールが消える。
// もう 1 本は取消（応答する＝ホストは印刷済みとみなしスプールが消える。PDF は作られない）。
//
// 実行: npm run build && node --env-file=.env --env-file=.env.verify scripts/verify-printer-hold-server.mjs
//   env: PUB400_USER / PUB400_PASSWORD（任意 PUB400_HOST）
// **スプールは最後に消す**。装置は PUB400 が切断後も持つので、ほかのスクリプトと同じく毎回別の名前にする。
import { mkdtempSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Session5250 } from "@ts5250/tn5250";
import { SessionManager } from "../packages/server/dist/session-manager.js";

const HOST = process.env.PUB400_HOST ?? "pub400.com";
const USER = process.env.PUB400_USER;
const PW = process.env.PUB400_PASSWORD;
if (!USER || !PW) { process.stderr.write("PUB400_USER / PUB400_PASSWORD が要ります（.env）\n"); process.exit(2); }
const PRTDEV = "VS" + String(Date.now() % 100000).padStart(5, "0");
const log = (s) => process.stderr.write(`${s}\n`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rows = (snap) => snap.cells.map((r) => r.map((c) => c.char).join("").replace(/\s+$/, ""));
const inputs = (snap) => snap.fields.filter((f) => !f.protected);
let pass = 0, fail = 0;
const check = (c, m) => { if (c) { pass++; log(`  PASS ${m}`); } else { fail++; log(`  FAIL ${m}`); } };

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
/** 待ち行列の QPRTLIBL の状態。用紙の問い合わせ（MSGW）には I で答える */
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
const waitHeld = async (entry, n) => {
  for (let i = 0; i < 40; i++) {
    const held = entry.outputStatuses.filter((x) => x.held).length;
    if (held >= n) return true;
    await sleep(500);
  }
  return false;
};

const base = mkdtempSync(join(tmpdir(), "prt-hold-"));
const pdfDir = join(base, "not-yet");
const sessions = new SessionManager();
const entry = await sessions.openPrinter({ host: HOST, port: 23, deviceName: PRTDEV, user: USER, password: PW, output: { autoPdfDir: pdfDir } });
log(`プリンター起動: ${entry.session?.startupCode}`);
const s = await display();
try {
  await cmd(s, `CHGJOB OUTQ(${PRTDEV})`);
  // ---- 再試行 ----
  await cmd(s, "DSPLIBL OUTPUT(*PRINT)");
  await sleep(2000);
  for (let i = 0; i < 4 && entry.reports.length < 1; i++) { log(`届く前 ${await spoolState(s, true)}`); await sleep(3000); }
  check(await waitHeld(entry, 1), "PDF が書けずに応答を止めた（held）");
  await sleep(5000);
  check((await spoolState(s)) === "WTR", "止めている間スプールはホストに残る（WTR）");
  mkdirSync(pdfDir);
  sessions.retryPrinterOutput(entry.id);
  await sleep(6000);
  const last = entry.outputStatuses[entry.outputStatuses.length - 1];
  check(last?.pdf?.ok === true && !last.held, "再試行で PDF ができた");
  check(readdirSync(pdfDir).some((f) => f.endsWith(".pdf")), "保存先に PDF がある");
  check((await spoolState(s)) === "(無し)", "応答したのでスプールが消えた（SAVE(*NO)）");
  // ---- 取消 ----
  rmSync(pdfDir, { recursive: true });
  await cmd(s, "DSPLIBL OUTPUT(*PRINT)");
  await sleep(2000);
  for (let i = 0; i < 4 && entry.reports.length < 2; i++) { log(`届く前 ${await spoolState(s, true)}`); await sleep(3000); }
  check(await waitHeld(entry, 2), "2 本目も応答を止めた");
  sessions.cancelPrinterOutput(entry.id);
  await sleep(6000);
  check(entry.outputStatuses[entry.outputStatuses.length - 1]?.canceled === true, "取消した");
  check((await spoolState(s)) === "(無し)", "取消で応答したのでスプールが消えた");
} finally {
  log("--- 片付け ---");
  for (let i = 0; i < 3; i++) await cmd(s, "DLTSPLF FILE(QPRTLIBL) JOB(*) SPLNBR(*LAST)");
  await cmd(s, "SIGNOFF");
  s.disconnect();
  sessions.stopPrinter?.(entry.id);
  entry.session?.disconnect();
  rmSync(base, { recursive: true, force: true });
}
log(`RESULT: pass=${pass} fail=${fail}`);
process.exit(fail > 0 ? 1 : 0);
