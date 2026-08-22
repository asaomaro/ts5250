// **常駐プリンターを長時間保てるか**を実機で測る（backlog `hostserver.md`）。
//
// 分かっていること: DTAQ 監視は 45 分のアイドルを越えられている。**プリンターは未測定**。
// 見たいのは 2 つ:
//
//   1. **アイドルを挟んでも帳票が届き続けるか**（接続が黙って死んでいないか）
//   2. **`REPORT_LIMIT`(50) を越えて古い帳票が落ちた状態**を実機で作る
//      （単体では `printer-residency.test.ts` が 60 件投入で押さえているだけ）
//
// 実行:
//   node --env-file=.env scripts/measure-printer-residency-long.mjs            # 既定 90 分
//   MINUTES=240 node --env-file=.env scripts/measure-printer-residency-long.mjs
//   MINUTES=0 node --env-file=.env scripts/measure-printer-residency-long.mjs  # 上限だけ見る
//
// ⚠ **アイドルの間は何も送らない。** 定期的に叩くと「使い続けていれば保つ」しか分からない。
// 副作用: 既存の仮想プリンター装置を借り（既定 PRT_ASAO）、自分のジョブのスプールを流す。
// ライターは必ず止め、スプールは消す。**装置は作らない・消さない。**
import { mkdtempSync, readdirSync, rmSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "@ts5250/server";
import { CommandConnection } from "@ts5250/hostserver";

const host = process.env.AS400_HOST;
const user = process.env.AS400_USER;
const password = process.env.AS400_PASSWORD;
if (!host || !user || !password) {
  process.stderr.write("AS400_HOST / AS400_USER / AS400_PASSWORD を環境変数で渡してください\n");
  process.exit(2);
}
const PRTDEV = process.env.AS400_PRTDEV ?? "PRT_ASAO";
const MINUTES = Number(process.env.MINUTES ?? 90);
const OUT = process.env.LOGFILE;
const log = (s) => {
  const line = `[${new Date().toISOString().slice(11, 19)}] ${s}`;
  process.stdout.write(line + "\n");
  if (OUT) appendFileSync(OUT, line + "\n");
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
const check = (cond, msg) => { if (cond) { pass++; log(`  PASS ${msg}`); } else { fail++; log(`  FAIL ${msg}`); } };

/** 1 件流して届くまで待つ。届いた件数の増分を返す */
async function sendAndWait(cc, entry, waitMs = 90_000) {
  const before = entry.reports.length;
  await cc.run("DSPLIBL OUTPUT(*PRINT)");
  const t0 = Date.now();
  while (Date.now() - t0 < waitMs && entry.reports.length === before) await sleep(1000);
  return { got: entry.reports.length - before, ms: Date.now() - t0 };
}

const outDir = mkdtempSync(join(tmpdir(), "residlong-"));
const sessions = new SessionManager();
let cc, entry;
try {
  cc = await CommandConnection.connect({ host, user, password });
  await cc.run(`ENDWTR WTR(${PRTDEV}) OPTION(*IMMED)`).catch(() => {});
  await cc.run(`CLROUTQ OUTQ(${PRTDEV})`).catch(() => {});
  await sleep(2000);
  await cc.run(`VRYCFG CFGOBJ(${PRTDEV}) CFGTYPE(*DEV) STATUS(*ON)`).catch(() => {});

  entry = await sessions.openPrinter({
    host,
    user,
    password,
    deviceName: PRTDEV,
    // ⚠ **常駐にするのは `service`。`output` ではない。**
    // 「開いている間だけ PDF に落とす」と「常駐して溜める」は別の軸
    // （`session-manager.ts` の `const resident = opts.service === true`）。
    // ここを取り違えると 30 分のアイドル掃除に掛かる普通のセッションを測ってしまう
    service: true,
    output: { autoPdfDir: outDir }
  });
  if (entry.resident !== true) throw new Error("常駐になっていない（service を見直すこと）");
  await cc.run(`STRPRTWTR DEV(${PRTDEV}) OUTQ(${PRTDEV})`);
  await cc.run(`CHGJOB OUTQ(${PRTDEV})`);
  log(`常駐セッション id=${entry.id} resident=${entry.resident}`);
  // **ブラウザが居ない状態にする**（購読を外す。セッションは切らない）
  entry.onReport = undefined;
  entry.onOutputWarn = undefined;
  entry.onOutputStatus = undefined;

  // ---- A. 上限（REPORT_LIMIT）を越える ----
  log("\n### A. REPORT_LIMIT を越えた状態を実機で作る");
  const TARGET = Number(process.env.REPORTS ?? 55);
  for (let i = 0; i < TARGET; i++) {
    await cc.run("DSPLIBL OUTPUT(*PRINT)");
    if (i % 10 === 9) log(`  ${i + 1} 件投入 → 受信 ${entry.reports.length} 件`);
    await sleep(400);
  }
  const t0 = Date.now();
  while (Date.now() - t0 < 180_000 && entry.reports.length < 51) await sleep(2000);
  log(`  投入 ${TARGET} 件 → 保持 ${entry.reports.length} 件 / 累計 ${entry.receivedTotal ?? "?"}`);
  check(entry.reports.length <= 50, `保持は上限 50 で頭打ち（実際 ${entry.reports.length}）`);
  check((entry.receivedTotal ?? 0) > entry.reports.length, "累計は落ちた分も数えている");
  const pdfs = readdirSync(outDir).length;
  log(`  PDF ${pdfs} 件`);
  check(pdfs >= entry.reports.length, "落ちた帳票も PDF には残っている（取りこぼさない）");

  // ---- B. アイドルを挟んで生きているか ----
  if (MINUTES > 0) {
    log(`\n### B. ${MINUTES} 分のアイドルを挟む（**この間は何も送らない**）`);
    const marks = [];
    for (let m = 15; m <= MINUTES; m += 15) marks.push(m);
    let waited = 0;
    for (const m of marks) {
      await sleep((m - waited) * 60_000);
      waited = m;
      const r = await sendAndWait(cc, entry);
      log(`  ${m} 分アイドル後: 受信 ${r.got} 件 / ${Math.round(r.ms / 1000)}s 待ち / 保持 ${entry.reports.length}`);
      check(r.got >= 1, `${m} 分のアイドルを越えて帳票が届く`);
      if (r.got === 0) { log("  **ここで切れた。以降は測っても意味が無いので止める**"); break; }
    }
  }
} catch (e) {
  fail++;
  log(`  FAIL 例外: ${e?.stack ?? e}`);
} finally {
  try { if (entry) await sessions.close(entry.id); } catch { /* 良い */ }
  try { if (cc) await cc.run(`ENDWTR WTR(${PRTDEV}) OPTION(*IMMED)`); } catch { /* 良い */ }
  try { if (cc) await cc.run(`CLROUTQ OUTQ(${PRTDEV})`); } catch { /* 良い */ }
  cc?.close?.();
  try { rmSync(outDir, { recursive: true, force: true }); } catch { /* 良い */ }
}
log(`\n${fail === 0 ? "OK" : "NG"} — ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
