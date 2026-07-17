// 実機検証（実ブラウザではなく core）: TN5250E プリンターセッションを PUB400 で end-to-end 検証する。
// PrinterSession で待ち受け → 表示セッションから自前スプールをそのプリンター OUTQ へ回し →
// ライターの用紙タイプ問い合わせ(CPA3394)に応答 → SCS を受信して論理ページに展開できることを確認する。
// 実行: node --env-file=.env scripts/verify-printer.mjs
//   env: PUB400_USER / PUB400_PASSWORD（任意 PUB400_HOST）
import { PrinterSession, Session5250 } from "@as400web/core";

const HOST = process.env.PUB400_HOST ?? "pub400.com";
const USER = process.env.PUB400_USER;
const PW = process.env.PUB400_PASSWORD;
// PUB400 は切断後もデバイスを保持するため、毎回ユニークなデバイス名を使う
const PRTDEV = "VP" + (Date.now() % 100000);

const log = (s) => process.stderr.write(s + "\n");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
const assert = (cond, msg) => { if (cond) { pass++; log("  PASS " + msg); } else { fail++; log("  FAIL " + msg); } };

async function run(s, cmd) {
  const f = s.snapshot().fields.filter((x) => !x.protected).at(-1);
  s.setField({ index: f.index }, cmd);
  return (await s.sendAid("Enter", { cursor: { row: f.row, col: f.col }, timeoutMs: 15000 })).screen;
}
async function connectDisplay() {
  let last;
  for (let i = 0; i < 5; i++) {
    try {
      const s = await Session5250.connect({ host: HOST, port: 23, deviceName: `VPD${i}`.slice(0, 10), user: USER, password: PW });
      await s.waitForScreen({ timeoutMs: 8000, until: { text: "Main Menu" } }).catch(() => {});
      if (s.snapshot().fields.some((f) => !f.protected)) return s;
      s.disconnect();
    } catch (e) { last = e; }
    await sleep(2000);
  }
  throw last ?? new Error("no command screen");
}

// ---- プリンターセッションを開いて待ち受ける ----
const reports = [];
const prt = await PrinterSession.connect({ host: HOST, port: 23, deviceName: PRTDEV, user: USER, password: PW });
prt.on("report", (r) => reports.push(r));
log(`プリンター起動: ${prt.startupCode}  device=${PRTDEV}`);
assert(prt.startupCode === "I902", `起動応答が I902（実際: ${prt.startupCode}）`);

// ---- 表示セッションから自前スプールをプリンター OUTQ へ回す ----
const disp = await connectDisplay();
try {
  await run(disp, `CHGJOB OUTQ(${PRTDEV})`);
  await run(disp, `DSPLIBL OUTPUT(*PRINT)`);
  await sleep(2000);
  // ライターの用紙タイプ問い合わせ(CPA3394)に "I"（現用紙で印刷）を返す
  let scr = await run(disp, `WRKOUTQ OUTQ(${PRTDEV})`);
  const snap = scr;
  const fileRow = snap.cells.findIndex((r) => r.map((c) => c.char).join("").includes("QPRTLIBL"));
  if (fileRow >= 0) {
    const opt = snap.fields.filter((f) => !f.protected && f.row === fileRow + 1).sort((a, b) => a.col - b.col)[0];
    if (opt) {
      disp.setField({ index: opt.index }, "7"); // Messages
      const r = await disp.sendAid("Enter", { cursor: { row: opt.row, col: opt.col }, timeoutMs: 15000 });
      const reply = r.screen.fields.filter((f) => !f.protected).sort((a, b) => b.row - a.row || b.col - a.col)[0];
      if (reply) {
        disp.setField({ index: reply.index }, "I");
        await disp.sendAid("Enter", { cursor: { row: reply.row, col: reply.col }, timeoutMs: 15000 }).catch(() => {});
        log('CPA3394 に "I" を返信');
      }
    }
  }
  await disp.sendAid("F3").catch(() => {});
  // スプール受信を待つ
  const t0 = Date.now();
  while (Date.now() - t0 < 20000 && reports.length === 0) await sleep(500);
} finally {
  await disp.disconnect();
}

// ---- 検証 ----
assert(reports.length >= 1, `スプールを 1 件以上受信（実際: ${reports.length}）`);
if (reports.length) {
  const text = reports[0].pages.map((p) => p.lines.join("\n")).join("\n");
  log("--- 受信帳票（先頭）---\n" + text.split("\n").slice(0, 6).join("\n"));
  assert(reports[0].pages.length >= 1, "論理ページが 1 ページ以上");
  assert(/Library List/.test(text), "帳票に 'Library List' が含まれる");
  assert(/QSYS/.test(text), "帳票に 'QSYS' が含まれる");
}
prt.disconnect();

log(`\n${fail === 0 ? "OK" : "NG"} — ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
