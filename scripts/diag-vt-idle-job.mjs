// **pub400 の VT がアイドルで死ぬのはホストがジョブを終わらせているからか**を割る。
//
// 分かっていること（2026-08-22 実測・すべて pub400・同じ 23 番・キープアライブ有効）:
//
//   - **5250 表示（サインオン済み）**: 30 分アイドルを**越えた**
//   - **VT（未サインオン）**: 30 分で**黙って死んだ**
//   - **VT（サインオン済み）**: 30 分で**黙って死んだ**
//
// どちらの層も**定期送信を持たない**ので、両方とも本当にアイドル。
// 経路が落とすなら 5250 も死ぬはずなので、**経路ではない**。
//
// ここで割るのは 2 つ:
//
//   A. **ホストが VT の対話ジョブを終わらせている**（`QDEVRCYACN` 等の方針）
//   B. **ジョブは生きているのに接続だけ死んでいる**
//
// ⚠ **VT のソケットには触らない。** 触るとアイドルが崩れる。
// 装置名を先に控えて、**別のホストサーバー接続から**ジョブの生死を 60 秒ごとに見る。
//
// 実行: IDLE_MIN=30 node --env-file=.env scripts/diag-vt-idle-job.mjs
import { appendFileSync } from "node:fs";
import { VtSession } from "@ts5250/vt";
import { DbConnection, query } from "@ts5250/hostserver";

const host = process.env.PUB400_HOST;
const user = process.env.PUB400_USER;
const password = process.env.PUB400_PASSWORD;
if (!host || !user || !password) {
  process.stderr.write("PUB400_HOST / _USER / _PASSWORD が要ります\n");
  process.exit(2);
}
const IDLE_MIN = Number(process.env.IDLE_MIN ?? 30);
const OUT = process.env.LOGFILE;
const log = (s) => {
  const line = `[${new Date().toISOString().slice(11, 19)}] ${s}`;
  process.stdout.write(line + "\n");
  if (OUT) appendFileSync(OUT, line + "\n");
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const s = await VtSession.connect({
  host, port: 23, rows: 24, cols: 80, terminalTypes: ["VT220"], ccsid: 37
});
const screen = () =>
  s.snapshot().cells.map((r) => r.map((c) => (c.width === 0 ? "" : c.char)).join("").replace(/ +$/u, "")).join("\n");

let closed;
s.on("close", (r) => {
  closed = r ?? "（理由なし）";
  log(`  **close が届いた**: ${closed}`);
});

/** 1 文字送って画面が変わるか。**アイドル明けにしか呼ばない** */
async function echoes(waitMs) {
  const before = screen();
  s.text("x");
  const t0 = Date.now();
  while (Date.now() - t0 < waitMs) {
    await sleep(500);
    if (screen() !== before) return { ok: true, ms: Date.now() - t0 };
  }
  return { ok: false, ms: Date.now() - t0 };
}

/** 装置名でジョブを引く。**VT のソケットとは別の接続**から見る */
async function jobOf(db, device) {
  const r = await query(
    db,
    `SELECT JOB_NAME, JOB_STATUS FROM TABLE(QSYS2.ACTIVE_JOB_INFO(
       JOB_NAME_FILTER => '${device}')) WHERE JOB_TYPE = 'INT'`
  );
  const x = r.rows[0];
  return x ? `${String(x.JOB_NAME).trim()} ${String(x.JOB_STATUS).trim()}` : undefined;
}

let db;
try {
  await sleep(4000);
  const signon = screen();
  if (signon.trim() === "") throw new Error("画面が来ていない");
  // **装置名を控える。** サインオン画面が `Display name . . . : QPADEVxxxx` を出す
  const device = /(QPADEV[0-9A-Z]+)/u.exec(signon)?.[1];
  if (!device) throw new Error(`装置名が読めない: ${signon.split("\n").find((l) => l.includes("evice")) ?? "?"}`);
  log(`装置 ${device} / ホスト ECHO=${s.hostEchoes}`);

  // サインオンして対話ジョブを作る
  s.text(user); await sleep(600);
  s.key({ key: "Tab" }); await sleep(900);
  s.text(password); await sleep(600);
  s.key({ key: "Enter" }); await sleep(8000);
  if (/Press Enter|継続するには/iu.test(screen())) { s.key({ key: "Enter" }); await sleep(4000); }
  if (!/Main Menu|メインメニュー|MAIN/u.test(screen())) {
    throw new Error(`サインオンできていない: ${screen().split("\n").find((l) => l.trim()) ?? "(空)"}`);
  }
  log("  サインオンした");

  db = await DbConnection.connect({ host, user, password });
  log(`対照: ジョブ = ${(await jobOf(db, device)) ?? "**見つからない**"}`);

  // ---- アイドル。**VT には触らず**、ジョブだけ外から見る ----
  log(`\n### ${IDLE_MIN} 分のアイドル（VT には何も送らない。ジョブは 60 秒ごとに外から見る）`);
  let lost;
  for (let m = 1; m <= IDLE_MIN; m++) {
    await sleep(60_000);
    let j;
    try { j = await jobOf(db, device); }
    catch (e) { log(`  ${m} 分: ジョブを引けず（${String(e.message).slice(0, 40)}）`); continue; }
    if (j === undefined && lost === undefined) {
      lost = m;
      log(`  **${m} 分でジョブが消えた**`);
    } else if (m % 5 === 0) {
      log(`  ${m} 分: ジョブ = ${j ?? "（無し）"} / close=${closed ?? "未着"}`);
    }
  }

  // ---- 明け ----
  log(`\n### アイドル明け`);
  log(`  ジョブ: ${(await jobOf(db, device)) ?? "**消えている**"}`);
  log(`  close は届いているか: ${closed ?? "**届いていない**"}`);
  const a = await echoes(60_000);
  log(`  送った文字が返る=${a.ok} / ${a.ms}ms`);

  log("\n### 判定");
  if (a.ok) log("  **越えられた**（今回は死ななかった）");
  else if (lost !== undefined) log(`  **A: ホストがジョブを終わらせた**（${lost} 分で消えた）`);
  else log("  **B: ジョブは生きているのに接続だけ死んだ**");
} catch (e) {
  log(`例外: ${e?.message ?? e}`);
} finally {
  try { s.text("SIGNOFF"); s.key({ key: "Enter" }); await sleep(2000); } catch { /* 良い */ }
  try { s.close(); } catch { /* 良い */ }
  try { db?.close(); } catch { /* 良い */ }
}
