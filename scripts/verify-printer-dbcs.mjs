// 実機検証（core）: DBCS プリンターセッションを PUB400 で end-to-end 検証する。
// CCSID 1399 で待ち受け、TESTLIB のライブラリテキストを日本語に変えて DSPLIBL を印刷 → 帳票を受信する。
// 実行: node --env-file=.env --env-file=.env.verify scripts/verify-printer-dbcs.mjs
//   env: PUB400_USER / PUB400_PASSWORD（任意 PUB400_HOST）。要 TESTLIB（自分のライブラリ）。
//
// ⚠ **2026-09-21 から日本語は届かない（英語機のため）**（`20260921-printer-acs-declaration`）。
// プリンターの申告を ACS と同じ組にした——DBCS は IBM-5553-B01 で、CODEPAGE / CHARSET を送らない。
// 英語機（PUB400）では装置の文字セットがシステムの既定（37）になり、日本語は置換される。
// 以前は CODEPAGE / CHARSET を送っていたのでここでは届いたが、**日本語機では装置が 3812 にされ、IGC 属性の
// 帳票が CPA3303 で止まっていた**。日本語の帳票の検証は日本語機で行う（`verify-printer-dbcs-push.mjs`）。
// ここでは 5553 の装置が作られて帳票が届くこと（用紙・位置合わせの問い合わせに答えた後）までを確かめ、
// 日本語が載るかは記録だけにする。ACS 自体を PUB400 に当てて同じ結果になるかは未確認（送るバイト列は
// ACS と同じであることを `packages/tn5250/test/telnet-printer.test.ts` で固定している）。
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
  await run(disp, `CHGLIB LIB(TESTLIB) TEXT('${JP}')`);
  await run(disp, `CHGJOB OUTQ(${PRTDEV})`);
  await run(disp, "DSPLIBL OUTPUT(*PRINT)");
  await sleep(2000);
  // 書き出しプログラムの問い合わせに "I" で答える。**DBCS は装置が 5553 として作られる**ので、用紙（CPA3394）の後に
  // 位置合わせ（CPA4044）も来る（`20260921-printer-acs-declaration`。ACS の申告に揃えた結果で、ACS でも同じ）
  for (let round = 0; round < 3 && reports.length === 0; round++) {
    const scr = await run(disp, `WRKOUTQ OUTQ(${PRTDEV})`);
    const fileRow = scr.cells.findIndex((r) => r.map((c) => c.char).join("").includes("QPRTLIBL"));
    if (fileRow < 0) break;
    const opt = scr.fields.filter((f) => !f.protected && f.row === fileRow + 1).sort((a, b) => a.col - b.col)[0];
    if (!opt) break;
    disp.setField({ index: opt.index }, "7");
    const r = await disp.sendAid("Enter", { cursor: { row: opt.row, col: opt.col }, timeoutMs: 15000 });
    const id = r.screen.cells.map((row) => row.map((c) => c.char).join("")).map((t) => /(CPA\d{4})/.exec(t)?.[1]).find(Boolean);
    const reply = r.screen.fields.filter((f) => !f.protected).sort((a, b) => b.row - a.row || b.col - a.col)[0];
    if (reply && (id === "CPA3394" || id === "CPA4044")) {
      disp.setField({ index: reply.index }, "I");
      await disp.sendAid("Enter", { cursor: { row: reply.row, col: reply.col }, timeoutMs: 15000 }).catch(() => {});
      log(`${id} "I" 返信`);
    } else log(`書き出しプログラム: ${id ?? "（メッセージなし）"}`);
    await disp.sendAid("F3").catch(() => {});
    await sleep(3000);
  }
  await disp.sendAid("F3").catch(() => {});
  const t0 = Date.now();
  while (Date.now() - t0 < 20000 && reports.length === 0) await sleep(500);
} finally {
  await run(disp, "CHGLIB LIB(TESTLIB) TEXT(' ')").catch(() => {}); // テキストを戻す
  await disp.disconnect();
}

assert(reports.length >= 1, `スプールを 1 件以上受信（実際: ${reports.length}）`);
if (reports.length) {
  const hasSO = [...reports[0].raw].some((b) => b === 0x0e);
  const text = reports[0].pages.map((p) => p.lines.join("\n")).join("\n");
  // 英語機では日本語は置換される（上の注記）。合否にはせず、記録として出す
  log(`  INFO SCS に SO(0x0E)=${hasSO} / 帳票に '${JP}'=${text.includes(JP)}（英語機では false が正しい）`);
  log("--- 受信帳票（TESTLIB 行）---\n" + text.split("\n").filter((l) => /TESTLIB/.test(l)).join("\n"));
}
prt.disconnect();
log(`\n${fail === 0 ? "OK" : "NG"} — ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
