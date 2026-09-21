// 実機検証（core）: **日本語の帳票（IGC 属性）を、当 PJ のプリンターセッションが書き出し経路（push）で受けられるか**。
//
// `20260921-printer-acs-declaration`: 申告を ACS と同じ組（DBCS・HPT なし → IBM-5553-B01 ＋ 6 変数）にした。
// 以前は装置が 3812 にされ、ホストが CPA3303 で止まっていた（`docs/HOST-PRINT-TRANSFORM.md`）。
//
// CCSID は AS400_CCSID（既定 930。この機の SBCS はカナ系なので 5035 だと半角カナが化ける）。
// 手順: 装置を 3812 で作る（この機は自動構成を許さないので事前に作る。仮想制御装置に付けないと 8903）→
//       PrinterSession（DBCS の CCSID）で繋ぐ → 装置が 5553 に作り変えられたかを DSPDEVD で見る →
//       IGCDTA(*YES) の DSPLIBL を送り、書き出しプログラムの問い合わせ（CPA3394・CPA4044）に I で答える →
//       `report` が届き、日本語のページになるか → 装置・待ち行列を消す。
//
// 実行: node --env-file=.env --env-file=.env.verify scripts/verify-printer-dbcs-push.mjs
//   AS400_HOST / AS400_USER / AS400_PASSWORD（`.env`）。仮想制御装置は AS400_VRTCTL（既定 QVIRCD0001）。
import { PrinterSession, Session5250 } from "@ts5250/tn5250";

const host = process.env.AS400_HOST, user = process.env.AS400_USER, password = process.env.AS400_PASSWORD;
if (!host || !user || !password) { process.stderr.write("AS400_HOST / AS400_USER / AS400_PASSWORD が要ります（.env）\n"); process.exit(2); }
const CTLD = process.env.AS400_VRTCTL ?? "QVIRCD0001";
const DEV = `TSPV${String(Date.now() % 10000).padStart(4, "0")}`;
const log = (s) => process.stderr.write(`${s}\n`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rows = (snap) => snap.cells.map((r) => r.map((c) => c.char).join("").replace(/\s+$/, ""));
const inputsOf = (snap) => snap.fields.filter((f) => !f.protected);
let pass = 0, fail = 0;
const assert = (c, m) => { if (c) { pass++; log(`  PASS ${m}`); } else { fail++; log(`  FAIL ${m}`); } };

async function display() {
  const s = await Session5250.connect({ host, ccsid: 930 });
  await sleep(800);
  const inputs = inputsOf(s.snapshot());
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
    } else await s.sendAid("Enter", { timeoutMs: 10000 }).catch(() => {});
  }
  return s;
}
async function cmd(s, text) {
  const f = inputsOf(s.snapshot()).find((x) => x.length >= 50) ?? inputsOf(s.snapshot()).slice(-1)[0];
  s.setField({ index: f.index }, text);
  await s.sendAid("Enter", { cursor: { row: f.row, col: f.col }, timeoutMs: 20000 }).catch((e) => log(`  (${text}: ${e.message})`));
  await sleep(1200);
  const t = rows(s.snapshot());
  log(`  > ${text} → ${t.at(-1)?.trim() || t.at(-2)?.trim() || ""}`);
  return t;
}
const back = async (s) => { await s.sendAid("F3", { timeoutMs: 10000 }).catch(() => {}); await sleep(800); };

const s = await display();
let prt;
try {
  await cmd(s, `CRTDEVPRT DEVD(${DEV}) DEVCLS(*VRT) TYPE(3812) MODEL(1) FONT(011) CTL(${CTLD}) ONLINE(*NO) TEXT('ts5250 verify')`);
  const reports = [];
  prt = await PrinterSession.connect({ host, ccsid: Number(process.env.AS400_CCSID ?? 930), deviceName: DEV, warn: (m) => log(`  [warn] ${m}`) });
  prt.on("report", (r) => reports.push(r));
  assert(prt.startupCode === "I902", `起動応答が I902（実際: ${prt.startupCode}）`);

  const d = await cmd(s, `DSPDEVD DEVD(${DEV})`);
  const type = d.find((r) => r.includes("装置タイプ"))?.split(":").pop()?.trim();
  assert(type === "5553", `装置が 5553 として作り変えられた（実際: ${type}）`);
  await back(s);

  await cmd(s, `CHGJOB OUTQ(${DEV})`);
  await cmd(s, "OVRPRTF FILE(QPRTLIBL) IGCDTA(*YES)");
  await cmd(s, "DSPLIBL OUTPUT(*PRINT)");
  await sleep(3000);
  // 書き出しプログラムの問い合わせ（CPA3394 用紙・CPA4044 位置合わせ）に I で答える。CPA3303 なら失敗
  let stopped;
  for (let round = 0; round < 4 && reports.length === 0; round++) {
    const t = await cmd(s, `WRKOUTQ OUTQ(${DEV})`);
    const row = t.findIndex((r) => r.includes("QPRTLIBL"));
    if (row < 0 || !t[row].includes("MSGW")) { await back(s); await sleep(3000); continue; }
    const opt = inputsOf(s.snapshot()).filter((f) => f.row === row + 1).sort((a, b) => a.col - b.col)[0];
    s.setField({ index: opt.index }, "7");
    await s.sendAid("Enter", { cursor: { row: opt.row, col: opt.col }, timeoutMs: 15000 }).catch(() => {});
    await sleep(1000);
    const m = rows(s.snapshot());
    const id = m.map((r) => /メッセージ ID\s*\.[ .]*:\s*(\S+)/.exec(r)?.[1]).find(Boolean) ?? "?";
    log(`  書き出しプログラム: ${id}`);
    if (id !== "CPA3394" && id !== "CPA4044") { stopped = id; await back(s); await back(s); break; }
    const reply = inputsOf(s.snapshot()).sort((a, b) => b.row - a.row || b.col - a.col)[0];
    s.setField({ index: reply.index }, "I");
    await s.sendAid("Enter", { cursor: { row: reply.row, col: reply.col }, timeoutMs: 15000 }).catch(() => {});
    await back(s);
    await sleep(4000);
  }
  const t0 = Date.now();
  while (Date.now() - t0 < 15000 && reports.length === 0) await sleep(500);
  assert(stopped === undefined, `書き出しプログラムが止まらない（止まったメッセージ: ${stopped ?? "なし"}）`);
  assert(reports.length === 1, `帳票が 1 件確定した（実際: ${reports.length}）`);
  const text = reports[0]?.pages.flatMap((p) => p.lines).join("\n") ?? "";
  assert(/[぀-ヿ一-鿿]/.test(text), "帳票に日本語（全角）が載っている");
  log(`--- 帳票の先頭 ---\n${text.split("\n").slice(0, 8).join("\n")}`);
} finally {
  prt?.disconnect();
  await sleep(3000);
  log("--- 片付け ---");
  await cmd(s, "DLTSPLF FILE(QPRTLIBL) JOB(*) SPLNBR(*LAST)");
  await cmd(s, `VRYCFG CFGOBJ(${DEV}) CFGTYPE(*DEV) STATUS(*OFF)`);
  await sleep(2000);
  await cmd(s, `DLTDEVD DEVD(${DEV})`);
  await cmd(s, `DLTOUTQ OUTQ(QUSRSYS/${DEV})`);
  await cmd(s, `CHKOBJ OBJ(${DEV}) OBJTYPE(*DEVD)`);
  await cmd(s, "SIGNOFF");
  s.disconnect();
}
log(`RESULT: pass=${pass} fail=${fail}`);
process.exit(fail > 0 ? 1 : 0);
