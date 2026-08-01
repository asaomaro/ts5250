// **プリンターの常駐**を実機で通しで確かめる（`20260801-printer-session-residency`）。
//
// 「ブラウザを閉じても帳票が届き、PDF が保存される」——これが成立するかを見る。
// 単体テストは偽の接続なので、**実機のスプールが本当に PDF になるところ**は測れない。
//
// 実行: AS400_HOST=... AS400_USER=... AS400_PASSWORD=... node --env-file=.env \
//         scripts/verify-printer-residency.mjs
//
// 副作用: 既存の仮想プリンター装置を借り（既定 PRT_TEST）、自分のジョブのスプールを 1 件流す。
// ライターは必ず止め、スプールは消す。**装置は作らない・消さない。**
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "@as400web/server";
import { CommandConnection } from "@as400web/hostserver";

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

const outDir = mkdtempSync(join(tmpdir(), "resid-"));
const sessions = new SessionManager();
let cc;
let entry;
try {
  cc = await CommandConnection.connect({ host, user, password });
  // **前の実行の残骸を先に落とす。** ライターが古いセッションを掴んだままだと
  // スプールは READY のまま溜まり、こちらには何も届かない（実測で踏んだ）
  await cc.run(`ENDWTR WTR(${PRTDEV}) OPTION(*IMMED)`).catch(() => {});
  await cc.run(`CLROUTQ OUTQ(${PRTDEV})`).catch(() => {});
  await sleep(2000);
  await cc.run(`VRYCFG CFGOBJ(${PRTDEV}) CFGTYPE(*DEV) STATUS(*ON)`).catch(() => {});

  // ---- 1. 出力設定つきで開く＝常駐になる ----
  log("### 1. 出力設定つきで開く");
  entry = await sessions.openPrinter({
    host,
    user,
    password,
    deviceName: PRTDEV,
    // **これがあるから常駐になる**（サーバー設定由来のときだけ供給される値）
    output: { autoPdfDir: outDir }
  });
  log(`  id=${entry.id} resident=${entry.resident}`);
  // **ライターは自動では上がらない。** プリンターセッションを繋いだだけだと
  // スプールは READY のまま溜まる（実測）。明示的に起動する
  const w = await cc.run(`STRPRTWTR DEV(${PRTDEV}) OUTQ(${PRTDEV})`);
  log(`  STRPRTWTR → rc=0x${w.returnCode.toString(16)}${w.messages?.length ? " " + w.messages.map((m) => m.id).join(",") : ""}`);
  check(entry.resident === true, "出力設定つきは常駐になる");
  check(sessions.isResident(entry.id) === true, "isResident が true");
  check(sessions.size === 0, "表示セッションの枠を食わない（size=0）");

  // ---- 2. ブラウザ相当のフックを外す（＝タブを閉じた状態） ----
  log("\n### 2. 購読を外す（ブラウザを閉じた状態にする）");
  entry.onReport = undefined;
  entry.onOutputWarn = undefined;
  entry.onOutputStatus = undefined;
  log("  フックを外した（WS 切断相当。**セッションは切らない**）");

  // ---- 3. スプールを流す ----
  log("\n### 3. ブラウザが居ない状態でスプールを流す");
  await cc.run(`CHGJOB OUTQ(${PRTDEV})`);
  // **用紙タイプはずらさない。** ずらすと MSGW で止まってしまう
  // （それを狙うのは `research-msgw.mjs` の方）。ここは素通しさせたい
  await cc.run("DSPLIBL OUTPUT(*PRINT)");

  const t0 = Date.now();
  while (Date.now() - t0 < 45_000 && entry.reports.length === 0) await sleep(1000);
  log(`  受信した帳票: ${entry.reports.length} 件`);
  check(entry.reports.length >= 1, "ブラウザが居なくても帳票を受信する");

  // ---- 4. 自動出力（PDF）が走ったか ----
  log("\n### 4. 自動出力（PDF）");
  const t1 = Date.now();
  while (Date.now() - t1 < 20_000 && readdirSync(outDir).length === 0) await sleep(500);
  const files = readdirSync(outDir);
  log(`  ${outDir} → ${files.join(", ") || "(なし)"}`);
  check(files.length >= 1, "ブラウザが居なくても PDF が保存される");
  log(`  出力の警告: ${entry.outputWarnings.length} 件` +
      (entry.outputWarnings.length ? ` — ${entry.outputWarnings.at(-1).message}` : ""));

  // ---- 5. 未読の帳票が残る（開き直したときに読める） ----
  log("\n### 5. 開き直したときに読めるか");
  log(`  reports=${entry.reports.length} delivered=${entry.delivered}`);
  check(entry.reports.length > entry.delivered, "未配信の帳票がエントリに残っている");
} catch (e) {
  fail++;
  log(`  FAIL 例外: ${e?.message ?? e}`);
} finally {
  try { if (entry) await sessions.close(entry.id); } catch { /* 良い */ }
  try { if (cc) await cc.run(`ENDWTR WTR(${PRTDEV}) OPTION(*IMMED)`); } catch { /* 良い */ }
  // **自分が作ったスプールは消す**（READY のまま溜めない）
  try { if (cc) await cc.run(`CLROUTQ OUTQ(${PRTDEV})`); } catch { /* 良い */ }
  cc?.close?.();
  try { rmSync(outDir, { recursive: true, force: true }); } catch { /* 良い */ }
}

log(`\n${fail === 0 ? "OK" : "NG"} — ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
