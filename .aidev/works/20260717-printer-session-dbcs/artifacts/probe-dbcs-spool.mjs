// research: 実機で DBCS スプールを採取できるか試す。CCSID 1399 で MYLIB のライブラリテキストを
// 日本語に変え、DSPLIBL OUTPUT(*PRINT) をプリンター OUTQ へ回して SCS に SO/SI が乗るか見る。
import { PrinterSession, Session5250, codecForCcsid } from "file:///workspaces/as400-web-emulator/packages/core/dist/index.js";
import { writeFileSync } from "node:fs";

const HOST = process.env.PUB400_HOST ?? "pub400.com";
const USER = process.env.PUB400_USER, PW = process.env.PUB400_PASSWORD;
const PRTDEV = "DP" + (Date.now() % 100000);
const log = (s) => process.stderr.write(s + "\n");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const codec = codecForCcsid(1399);

async function run(s, cmd) {
  const f = s.snapshot().fields.filter((x) => !x.protected).at(-1);
  s.setField({ index: f.index }, cmd);
  return (await s.sendAid("Enter", { cursor: { row: f.row, col: f.col }, timeoutMs: 15000 })).screen;
}
const textOf = (snap) => snap.cells.map((r) => r.map((c) => c.char).join("")).join("\n");
async function connectDisplay() {
  for (let i = 0; i < 5; i++) {
    try {
      const s = await Session5250.connect({ host: HOST, port: 23, ccsid: 1399, deviceName: `DPD${i}`.slice(0, 10), user: USER, password: PW });
      await s.waitForScreen({ timeoutMs: 8000, until: { text: "Main Menu" } }).catch(() => {});
      if (s.snapshot().fields.some((f) => !f.protected)) return s;
      s.disconnect();
    } catch (e) { log("retry " + e.message); }
    await sleep(2000);
  }
  throw new Error("no cmd screen");
}

const reports = [];
const prt = await PrinterSession.connect({ host: HOST, port: 23, ccsid: 1399, deviceName: PRTDEV, user: USER, password: PW });
prt.on("report", (r) => reports.push(r));
log(`プリンター起動: ${prt.startupCode} device=${PRTDEV} (CCSID 1399)`);

const disp = await connectDisplay();
try {
  // MYLIB のテキストを日本語に（DBCS 入力が通るか）。通れば DSPLIBL に日本語が載る
  let scr = await run(disp, "CHGLIB LIB(MYLIB) TEXT('日本語テスト')");
  const t = textOf(scr);
  const errLine = t.split("\n").map((l) => l.trim()).find((l) => /CPF|CPD|not|error|エラー/i.test(l));
  log("CHGLIB 結果: " + (errLine ?? "OK(変更?)"));
  await run(disp, `CHGJOB OUTQ(${PRTDEV})`);
  await run(disp, "DSPLIBL OUTPUT(*PRINT)");
  await sleep(2000);
  // CPA3394 に応答
  scr = await run(disp, `WRKOUTQ OUTQ(${PRTDEV})`);
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
  // 後始末: テキストを戻す
  await run(disp, "CHGLIB LIB(MYLIB) TEXT(' ')").catch(() => {});
  await disp.disconnect();
}

if (reports.length) {
  const raw = reports[0].raw;
  const hasSO = [...raw].some((b) => b === 0x0e);
  writeFileSync("/tmp/claude-1000/-workspaces-as400-web-emulator/0d514ddf-60ce-4ba1-85fd-79b8f8491d4e/scratchpad/scs-capture-dbcs.bin", Buffer.from(raw));
  const text = reports[0].pages.map((p) => p.lines.join("\n")).join("\n");
  log(`受信 ${raw.length}B, SO(0x0E) 含む=${hasSO}`);
  log("--- 帳票（MYLIB 行あたり）---");
  log(text.split("\n").filter((l) => /MYLIB|日本|語|テスト/.test(l)).join("\n") || "(MYLIB 行見つからず)");
  log(text.split("\n").slice(6, 10).join("\n"));
  process.exit(hasSO ? 0 : 2);
} else {
  log("スプール受信なし"); process.exit(3);
}
