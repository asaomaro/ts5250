// **15 分のアイドル後に帳票が届かない理由を切り分ける**（backlog `hostserver.md`）。
//
// `measure-printer-residency-long.mjs` で「15 分アイドル後にスプールが届かない」と分かった。
// ⚠ **だが症状は同じでも原因は 2 つありうる**:
//
//   A. **こちらのソケットが黙って死んでいる**（NAT やファイアウォールが落とし、
//      キープアライブが無いのでどちらの端も気づかない）
//   B. **ホスト側の書き出しプログラム（ライター）が終わっている**
//      ——セッションは健全でも、スプールは OUTQ に READY のまま溜まる
//
// **どちらか決めずに直してはいけない**ので、アイドル明けに**両方**を見る:
//
//   - こちら側: `entry.state` と `entry.session` の有無
//   - ホスト側: ライターの状態（`QSYS2.OUTPUT_QUEUE_INFO`）と OUTQ に残った件数
//   - そのうえでスプールを 1 件流し、届くか／OUTQ に積まれたままかを見る
//
// 実行:
//   node --env-file=.env scripts/diag-printer-idle-cause.mjs            # 既定 16 分アイドル
//   IDLE_MIN=30 node --env-file=.env scripts/diag-printer-idle-cause.mjs
//
// 副作用: 既存の仮想プリンター装置を借りる（既定 PRT_ASAO）。スプールは 2 件流し、後始末する。
import { appendFileSync } from "node:fs";
import { SessionManager } from "@ts5250/server";
import { CommandConnection, DbConnection, query } from "@ts5250/hostserver";

const host = process.env.AS400_HOST;
const user = process.env.AS400_USER;
const password = process.env.AS400_PASSWORD;
if (!host || !user || !password) {
  process.stderr.write("AS400_HOST / AS400_USER / AS400_PASSWORD を環境変数で渡してください\n");
  process.exit(2);
}
const PRTDEV = process.env.AS400_PRTDEV ?? "PRT_ASAO";
const IDLE_MIN = Number(process.env.IDLE_MIN ?? 16);
const OUT = process.env.LOGFILE;
const log = (s) => {
  const line = `[${new Date().toISOString().slice(11, 19)}] ${s}`;
  process.stdout.write(line + "\n");
  if (OUT) appendFileSync(OUT, line + "\n");
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** OUTQ とライターの状態をホスト側から見る。**こちらの接続とは別の口で見る**のが要点 */
async function hostView(cred) {
  const db = await DbConnection.connect(cred);
  try {
    const q = await query(
      db,
      `SELECT OUTPUT_QUEUE_NAME, NUMBER_OF_FILES, WRITER_JOB_NAME, WRITER_JOB_STATUS
         FROM QSYS2.OUTPUT_QUEUE_INFO WHERE OUTPUT_QUEUE_NAME = '${PRTDEV}'`
    );
    const r = q.rows[0];
    if (!r) return "OUTQ が見つからない";
    return `件数=${r.NUMBER_OF_FILES} ライター=${String(r.WRITER_JOB_NAME ?? "（無し）").trim()} 状態=${String(r.WRITER_JOB_STATUS ?? "-").trim()}`;
  } catch (e) {
    return `見られず: ${String(e.message).slice(0, 60)}`;
  } finally {
    db.close();
  }
}

const cred = { host, user, password };
const sessions = new SessionManager();
let cc, entry;
try {
  cc = await CommandConnection.connect(cred);
  await cc.run(`ENDWTR WTR(${PRTDEV}) OPTION(*IMMED)`).catch(() => {});
  await cc.run(`CLROUTQ OUTQ(${PRTDEV})`).catch(() => {});
  await sleep(2000);
  await cc.run(`VRYCFG CFGOBJ(${PRTDEV}) CFGTYPE(*DEV) STATUS(*ON)`).catch(() => {});

  entry = await sessions.openPrinter({ host, user, password, deviceName: PRTDEV, service: true });
  if (entry.resident !== true) throw new Error("常駐になっていない");
  await cc.run(`STRPRTWTR DEV(${PRTDEV}) OUTQ(${PRTDEV})`);
  await cc.run(`CHGJOB OUTQ(${PRTDEV})`);
  entry.onReport = undefined;

  // ---- まず 1 件流して、経路が通っていることを確かめる ----
  log("### 対照: アイドル前に 1 件流す");
  log(`  ホスト側: ${await hostView(cred)}`);
  let before = entry.reports.length;
  await cc.run("DSPLIBL OUTPUT(*PRINT)");
  for (let i = 0; i < 60 && entry.reports.length === before; i++) await sleep(1000);
  log(`  受信 ${entry.reports.length - before} 件 / state=${entry.state}`);
  log(`  ホスト側: ${await hostView(cred)}`);
  if (entry.reports.length === before) throw new Error("アイドル前から届いていない（前提が崩れている）");

  // ---- アイドル ----
  log(`\n### ${IDLE_MIN} 分のアイドル（**何も送らない**）`);
  await sleep(IDLE_MIN * 60_000);

  // ---- 明けの観察。**流す前に両側を見る** ----
  log(`\n### アイドル明け`);
  log(`  こちら側: state=${entry.state} 接続あり=${entry.session !== undefined}`);
  log(`  ホスト側: ${await hostView(cred)}`);

  before = entry.reports.length;
  await cc.run("DSPLIBL OUTPUT(*PRINT)");
  for (let i = 0; i < 90 && entry.reports.length === before; i++) await sleep(1000);
  const got = entry.reports.length - before;
  log(`  流したあと: 受信 ${got} 件 / state=${entry.state} 接続あり=${entry.session !== undefined}`);
  const after = await hostView(cred);
  log(`  ホスト側: ${after}`);

  log("\n### 判定");
  if (got >= 1) {
    log("  **届いた**——この時間では落ちない");
  } else if (/ライター=（無し）|状態=(END|-)/u.test(after)) {
    log("  **B: ライターが終わっている**（ホスト側の問題。こちらの接続とは別）");
  } else {
    log("  **A: こちらのソケットが黙って死んでいる**"
      + "（ライターは動いていて OUTQ に積まれているのに届かない）");
  }
} catch (e) {
  log(`例外: ${e?.stack ?? e}`);
} finally {
  try { if (entry) await sessions.close(entry.id); } catch { /* 良い */ }
  try { if (cc) await cc.run(`ENDWTR WTR(${PRTDEV}) OPTION(*IMMED)`); } catch { /* 良い */ }
  try { if (cc) await cc.run(`CLROUTQ OUTQ(${PRTDEV})`); } catch { /* 良い */ }
  cc?.close?.();
}
