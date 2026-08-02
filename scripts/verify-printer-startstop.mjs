// **待ち受けの開始/停止**を実機で往復させる（`20260801-service-start-stop`）。
//
// 単体テストは偽の接続なので、**停止で装置を本当に手放しているか**は測れない。
// 手放していなければ、再開時に「装置が使用中」で繋がらない——そこを見る。
//
// 実行: AS400_HOST=... AS400_USER=... AS400_PASSWORD=... node --env-file=.env \
//         scripts/verify-printer-startstop.mjs
//
// 副作用: 既存の仮想プリンター装置を借り（既定 PRT_TEST）、スプールを 1 件流す。
// ライターは必ず止め、スプールは消す。**装置は作らない・消さない。**
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
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

const PRTDEV = process.env.AS400_PRTDEV ?? "PRT_TEST";
const log = (s) => process.stdout.write(s + "\n");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0;
let fail = 0;
const check = (cond, msg) => {
  if (cond) { pass++; log(`  PASS ${msg}`); } else { fail++; log(`  FAIL ${msg}`); }
};

const outDir = mkdtempSync(join(tmpdir(), "startstop-"));
const sessions = new SessionManager();
let cc;
let entry;
try {
  cc = await CommandConnection.connect({ host, user, password });
  // 前の実行の残骸を落としてから（ライターが古いセッションを掴んでいると何も届かない）
  await cc.run(`ENDWTR WTR(${PRTDEV}) OPTION(*IMMED)`).catch(() => {});
  await cc.run(`CLROUTQ OUTQ(${PRTDEV})`).catch(() => {});
  await sleep(2000);
  await cc.run(`VRYCFG CFGOBJ(${PRTDEV}) CFGTYPE(*DEV) STATUS(*ON)`).catch(() => {});

  // ---- 1. autoStart ☐ で開く＝待ち受けない ----
  log("### 1. autoStart ☐ で開く");
  entry = await sessions.openPrinter({
    host, user, password, deviceName: PRTDEV,
    ref: "srv:verify",
    service: true,
    autoStart: false,
    output: { autoPdfDir: outDir }
  });
  log(`  state=${entry.state} session=${entry.session ? "あり" : "なし"}`);
  check(entry.state === "stopped", "開いても待ち受けない");
  check(entry.session === undefined, "接続を持たない");
  check(sessions.size === 0 && sessions.listPrinters().length === 1, "一覧には出るが枠を食わない");

  // ---- 2. 開始 ----
  log("\n### 2. 開始");
  await sessions.startPrinter(entry.id);
  log(`  state=${entry.state} startupCode=${entry.session?.startupCode}`);
  check(entry.state === "listening", "待ち受けを開始できる");
  check(entry.session?.startupCode === "I902", `起動応答が I902（実際: ${entry.session?.startupCode}）`);

  // ---- 3. 受信 ----
  log("\n### 3. 受信");
  await cc.run(`STRPRTWTR DEV(${PRTDEV}) OUTQ(${PRTDEV})`).catch(() => {});
  await cc.run(`CHGJOB OUTQ(${PRTDEV})`);
  await cc.run("DSPLIBL OUTPUT(*PRINT)");
  const t0 = Date.now();
  while (Date.now() - t0 < 45_000 && entry.reports.length === 0) await sleep(1000);
  check(entry.reports.length >= 1, `帳票を受信する（実際: ${entry.reports.length} 件）`);

  // ---- 4. 停止（装置を手放したか） ----
  log("\n### 4. 停止");
  sessions.stopPrinter(entry.id);
  log(`  state=${entry.state} session=${entry.session ? "あり" : "なし"}`);
  check(entry.state === "stopped", "停止できる");
  check(entry.session === undefined, "接続を手放す");
  check(sessions.listPrinters().some((e) => e.id === entry.id), "一覧に残る（再開できる）");
  // **受信済みの帳票は残る**——停止は「消費をやめる」であって捨てることではない
  check(entry.reports.length >= 1, "受信済みの帳票は残る");

  // ---- 5. 再開（本当に手放していないと、ここで装置使用中になる） ----
  log("\n### 5. 再開");
  await sleep(3000);
  await sessions.startPrinter(entry.id);
  log(`  state=${entry.state} startupCode=${entry.session?.startupCode}`);
  check(entry.state === "listening", "**再開できる（＝停止で本当に装置を手放していた）**");

  // ---- 6. 開き直す（attach）----
  log("\n### 6. 開き直す（同じ ref）");
  const again = await sessions.openPrinter({
    host, user, password, deviceName: PRTDEV,
    ref: "srv:verify", service: true, output: { autoPdfDir: outDir }
  });
  log(`  1 回目 id=${entry.id} / 2 回目 id=${again.id}`);
  check(again.id === entry.id, "**同じエントリが返る（二重接続しない）**");
  check(sessions.listPrinters().length === 1, "一覧も 1 本のまま");
  check(again.reports.length >= 1, "閉じている間に届いた帳票が読める");

  log(`\n  PDF: ${readdirSync(outDir).join(", ") || "(なし)"}`);
} catch (e) {
  fail++;
  log(`  FAIL 例外: ${e?.message ?? e}`);
} finally {
  try { if (entry) await sessions.close(entry.id); } catch { /* 良い */ }
  try { if (cc) await cc.run(`ENDWTR WTR(${PRTDEV}) OPTION(*IMMED)`); } catch { /* 良い */ }
  try { if (cc) await cc.run(`CLROUTQ OUTQ(${PRTDEV})`); } catch { /* 良い */ }
  cc?.close?.();
  try { rmSync(outDir, { recursive: true, force: true }); } catch { /* 良い */ }
}

log(`\n${fail === 0 ? "OK" : "NG"} — ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
