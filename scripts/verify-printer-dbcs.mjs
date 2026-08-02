// 実機検証（core）: DBCS プリンターセッションを PUB400 で end-to-end 検証する。
// CCSID 1399 で待ち受け、MYLIB のライブラリテキストを日本語に変えて DSPLIBL を印刷 →
// SCS 中の SO/SI 付き全角を受信し、帳票に日本語が桁揃えで載ることを確認する。
// 実行: node --env-file=.env scripts/verify-printer-dbcs.mjs
//   env: PUB400_USER / PUB400_PASSWORD（任意 PUB400_HOST）。要 MYLIB（自分のライブラリ）。
import { PrinterSession, Session5250 } from "@ts5250/tn5250";

const HOST = process.env.PUB400_HOST ?? "pub400.com";
const USER = process.env.PUB400_USER, PW = process.env.PUB400_PASSWORD;
const PRTDEV = "DP" + (Date.now() % 100000);
const JP = "日本語テスト";

const log = (s) => process.stderr.write(s + "\n");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
const assert = (c, m) => { if (c) { pass++; log("  PASS " + m); } else { fail++; log("  FAIL " + m); } };

async function run(s, cmd) {
  const f = s.snapshot().fields.filter((x) => !x.protected).at(-1);
  s.setField({ index: f.index }, cmd);
  return (await s.sendAid("Enter", { cursor: { row: f.row, col: f.col }, timeoutMs: 15000 })).screen;
}
async function connectDisplay() {
  for (let i = 0; i < 5; i++) {
    try {
      const s = await Session5250.connect({ host: HOST, port: 23, ccsid: 1399, deviceName: `DPD${i}`.slice(0, 10), user: USER, password: PW });
      await s.waitForScreen({ timeoutMs: 8000, until: { text: "Main Menu" } }).catch(() => {});
      if (s.snapshot().fields.some((f) => !f.protected)) return s;
      s.disconnect();
    } catch { /* retry */ }
    await sleep(2000);
  }
  throw new Error("no command screen");
}

const reports = [];
const prt = await PrinterSession.connect({ host: HOST, port: 23, ccsid: 1399, deviceName: PRTDEV, user: USER, password: PW });
prt.on("report", (r) => reports.push(r));
log(`プリンター起動: ${prt.startupCode} device=${PRTDEV} (CCSID 1399)`);
assert(prt.startupCode === "I902", `起動応答が I902（実際: ${prt.startupCode}）`);

const disp = await connectDisplay();
try {
  await run(disp, `CHGLIB LIB(MYLIB) TEXT('${JP}')`);
  await run(disp, `CHGJOB OUTQ(${PRTDEV})`);
  await run(disp, "DSPLIBL OUTPUT(*PRINT)");
  await sleep(2000);
  let scr = await run(disp, `WRKOUTQ OUTQ(${PRTDEV})`);
  const fileRow = scr.cells.findIndex((r) => r.map((c) => c.char).join("").includes("QPRTLIBL"));
  if (fileRow >= 0) {
    const opt = scr.fields.filter((f) => !f.protected && f.row === fileRow + 1).sort((a, b) => a.col - b.col)[0];
    if (opt) {
      disp.setField({ index: opt.index }, "7");
      const r = await disp.sendAid("Enter", { cursor: { row: opt.row, col: opt.col }, timeoutMs: 15000 });
      const reply = r.screen.fields.filter((f) => !f.protected).sort((a, b) => b.row - a.row || b.col - a.col)[0];
      if (reply) { disp.setField({ index: reply.index }, "I"); await disp.sendAid("Enter", { cursor: { row: reply.row, col: reply.col }, timeoutMs: 15000 }).catch(() => {}); log('CPA3394 "I" 返信'); }
    }
  }
  await disp.sendAid("F3").catch(() => {});
  const t0 = Date.now();
  while (Date.now() - t0 < 20000 && reports.length === 0) await sleep(500);
} finally {
  await run(disp, "CHGLIB LIB(MYLIB) TEXT(' ')").catch(() => {}); // テキストを戻す
  await disp.disconnect();
}

assert(reports.length >= 1, `スプールを 1 件以上受信（実際: ${reports.length}）`);
if (reports.length) {
  const hasSO = [...reports[0].raw].some((b) => b === 0x0e);
  const text = reports[0].pages.map((p) => p.lines.join("\n")).join("\n");
  assert(hasSO, "受信 SCS に SO(0x0E)＝DBCS シフトが含まれる");
  assert(text.includes(JP), `帳票に日本語 '${JP}' が含まれる`);
  assert(/MYLIB {7}CUR {20}日本語/.test(text), "MYLIB 行の説明桁に日本語が桁揃えで載る");
  log("--- 受信帳票（MYLIB 行）---\n" + text.split("\n").filter((l) => /MYLIB/.test(l)).join("\n"));
}
prt.disconnect();
log(`\n${fail === 0 ? "OK" : "NG"} — ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
