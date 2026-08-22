// **表示セッション（5250 / VT）がアイドルを越えられるか**を実機で測る
// （backlog `hostserver.md`。プリンターで見つかった無言死が表示側にも当たるかの確認）。
//
// プリンターで分かったこと: `tn5250` / `vt` / `tn3270` の TCP に**キープアライブが無く**、
// 15 分のアイドルで接続が黙って死んでいた。**同じ `TcpTransport` を表示セッションも通る**
// ので、同じことが起きていたはず——それを実機で確かめる。
//
// ## ⚠ ホストの非活動タイマーと混ぜない
//
// `QINACTITV` は**非活動の対話ジョブをホット側から切る**設定。これに掛かった切断は
// **不具合ではなく設定どおり**なので、それより短い時間でしか transport の話は測れない。
//
//   - 実機: `QINACTITV = 10`（分）→ **10 分でホストが切る。30 分の試験には使えない**
//   - pub400:   `QINACTITV = 120`（分）→ 使える
//
// 実行:
//   HOSTPRE=PUB400 IDLE_MIN=30 node --env-file=.env scripts/diag-session-idle.mjs
//   HOSTPRE=AS400  IDLE_MIN=8  node --env-file=.env scripts/diag-session-idle.mjs  # 10 分未満で
//
// 副作用: 対話セッションを 1 本張り、アイドルを挟んで Enter を 1 回送るだけ。
import { appendFileSync } from "node:fs";
import { Session5250 } from "@ts5250/tn5250";

const PRE = process.env.HOSTPRE ?? "PUB400";
const host = process.env[`${PRE}_HOST`];
const user = process.env[`${PRE}_USER`];
const password = process.env[`${PRE}_PASSWORD`];
if (!host || !user || !password) {
  process.stderr.write(`${PRE}_HOST / ${PRE}_USER / ${PRE}_PASSWORD を環境変数で渡してください\n`);
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
const rows = (s) => s.cells.map((r) => r.map((c) => c.char).join("").replace(/\s+$/u, ""));

let closedReason;

/**
 * 接続する。**装置名は順に試す**——自動構成を切っている実機（）では
 * 登録済みの名前しか使えず、使用中なら `8940` で拒否される（`scripts/README.md`）。
 * `<PRE>_DEVNAMES` を省くと装置名を指定しない（pub400 のように自動構成が効く相手向け）。
 */
async function connectAny() {
  const pool = (process.env[`${PRE}_DEVNAMES`] ?? "").split(",").filter(Boolean);
  const attempts = pool.length > 0 ? pool : [undefined];
  let last;
  for (const dev of attempts) {
    try {
      return await Session5250.connect({
        host,
        port: Number(process.env[`${PRE}_PORT`] ?? 23),
        ccsid: Number(process.env[`${PRE}_CCSID`] ?? 37),
        user,
        password,
        ...(dev ? { deviceName: dev } : {}),
        warn: () => undefined
      });
    } catch (e) {
      last = e;
      log(`  装置 ${dev ?? "(自動)"} は使えず: ${String(e.message).slice(0, 60)}`);
    }
  }
  throw last;
}

const session = await connectAny();
session.on("closed", (reason) => {
  closedReason = reason ?? "（理由なし）";
  log(`  **closed が届いた**: ${closedReason}`);
});

try {
  await sleep(2000);
  // サインオン画面なら入れる（自動サインオンで既にメニューのこともある）
  const inputs = session.snapshot().fields.filter((f) => !f.protected);
  if (inputs.length >= 2 && rows(session.snapshot()).some((r) => /サイン|Sign On/iu.test(r))) {
    session.setField({ index: inputs[0].index }, user);
    session.setField({ index: inputs[1].index }, password);
    await session.sendAid("Enter", {
      cursor: { row: inputs[0].row, col: inputs[0].col },
      timeoutMs: 20000
    });
    await sleep(1500);
  }
  // ⚠ **「対話式ジョブの回復の試み」で止まったまま測らない。**
  // 前のセッションが残したジョブの回復画面で、通常の状態ではない
  // ——ここで放置した結果は普通のセッションの話として読めない。
  // オプション 90（回復しない）を選んで普通のメニューまで進める
  for (let i = 0; i < 6; i++) {
    const txt = rows(session.snapshot());
    if (!txt.some((r) => r.includes("対話式ジョブの回復"))) break;
    log("  「対話式ジョブの回復の試み」を抜ける（90 を選ぶ）");
    const f = session.snapshot().fields.filter((x) => !x.protected).slice(-1)[0];
    if (!f) break;
    session.setField({ index: f.index }, "90");
    await session.sendAid("Enter", { cursor: { row: f.row, col: f.col }, timeoutMs: 15000 });
    await sleep(1200);
  }
  const shown = rows(session.snapshot());
  if (shown.some((r) => r.includes("対話式ジョブの回復"))) {
    throw new Error("回復画面から抜けられない（この状態では測らない）");
  }

  const first = shown.filter((r) => r.trim())[0] ?? "(空)";
  log(`接続できた: ${first.slice(0, 60)}`);

  // ---- 対照: いま Enter を送って応答があることを確かめる ----
  const c = await session.sendAid("Enter", { timeoutMs: 20000 });
  log(`対照: Enter に応答 timedOut=${c.timedOut}`);
  if (c.timedOut) throw new Error("アイドル前から応答が無い（前提が崩れている）");

  // ---- アイドル ----
  log(`\n### ${IDLE_MIN} 分のアイドル（**何も送らない**）`);
  await sleep(IDLE_MIN * 60_000);

  // ---- 明けの観察 ----
  log(`\n### アイドル明け`);
  log(`  closed は届いているか: ${closedReason ?? "**届いていない**"}`);
  const t0 = Date.now();
  let timedOut = true;
  let err;
  try {
    const r = await session.sendAid("Enter", { timeoutMs: 60000 });
    timedOut = r.timedOut;
  } catch (e) {
    err = e?.message ?? String(e);
  }
  const ms = Date.now() - t0;
  log(`  Enter を送った: ${err ? `例外 ${err.slice(0, 60)}` : `timedOut=${timedOut}`} / ${ms}ms`);

  log("\n### 判定");
  if (!err && !timedOut) log(`  **越えられた**——${IDLE_MIN} 分のアイドル後も応答する`);
  else if (closedReason) log(`  **切れていた（理由あり）**: ${closedReason}`);
  else log("  **黙って死んでいた**——closed も来ず、送っても応答が無い");
} catch (e) {
  log(`例外: ${e?.stack ?? e}`);
} finally {
  try { session.disconnect(); } catch { /* 良い */ }
}
