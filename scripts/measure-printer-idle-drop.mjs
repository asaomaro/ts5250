// **常駐プリンターの接続がアイドルでいつ落ちるか**を実機で特定する（backlog `hostserver.md`）。
//
// `measure-printer-residency-long.mjs` で「15 分のアイドル後にスプールが届かない」ことが
// 分かった。だが**届かない理由は 2 つありうる**:
//
//   1. プリンターの接続が落ちている
//   2. 接続は生きているが、書き出しプログラムやスプールの側で止まっている
//
// ここは **1 を切り分ける**ためのもの。`entry.state` を**受動的に**見るだけで、
// ⚠ **プリンター接続には何も送らない**——送ると測っているアイドルそのものを崩す。
//
// `SessionManager` は落ちたとき `state` を `"error"` / `"disconnected"` にして
// `entry.session` を消す（自動再接続は無い）。その瞬間の経過時間が答え。
//
// 実行:
//   node --env-file=.env scripts/measure-printer-idle-drop.mjs            # 既定 40 分まで見る
//   MINUTES=120 node --env-file=.env scripts/measure-printer-idle-drop.mjs
//
// 副作用: 既存の仮想プリンター装置を借りるだけ（既定 PRT_ASAO）。**スプールは流さない。**
import { appendFileSync } from "node:fs";
import { SessionManager } from "@ts5250/server";

const host = process.env.AS400_HOST;
const user = process.env.AS400_USER;
const password = process.env.AS400_PASSWORD;
if (!host || !user || !password) {
  process.stderr.write("AS400_HOST / AS400_USER / AS400_PASSWORD を環境変数で渡してください\n");
  process.exit(2);
}
const PRTDEV = process.env.AS400_PRTDEV ?? "PRT_ASAO";
const MINUTES = Number(process.env.MINUTES ?? 40);
const OUT = process.env.LOGFILE;
const log = (s) => {
  const line = `[${new Date().toISOString().slice(11, 19)}] ${s}`;
  process.stdout.write(line + "\n");
  if (OUT) appendFileSync(OUT, line + "\n");
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const sessions = new SessionManager();
let entry;
const t0 = Date.now();
try {
  entry = await sessions.openPrinter({ host, user, password, deviceName: PRTDEV, service: true });
  if (entry.resident !== true) throw new Error("常駐になっていない");
  log(`常駐 id=${entry.id} state=${entry.state} 接続あり=${entry.session !== undefined}`);
  // **ブラウザが居ない状態**にする（購読を外す。セッションは切らない）
  entry.onReport = undefined;
  entry.onOutputWarn = undefined;
  entry.onOutputStatus = undefined;
  log(`**この先はプリンター接続に何も送らない。** ${MINUTES} 分まで 60 秒ごとに状態だけ見る`);

  let last = entry.state;
  for (let i = 1; i <= MINUTES; i++) {
    await sleep(60_000);
    const min = Math.round((Date.now() - t0) / 60_000);
    const now = entry.state;
    const alive = entry.session !== undefined;
    if (now !== last) {
      log(`**${min} 分で状態が変わった**: ${last} → ${now}${entry.error ? ` (${entry.error})` : ""} / 接続あり=${alive}`);
      last = now;
      if (now === "error") {
        log("  ここが答え。**自動再接続は無い**ので、以降は届かない");
        break;
      }
    } else if (i % 5 === 0) {
      log(`  ${min} 分: state=${now} 接続あり=${alive}（変化なし）`);
    }
  }
  const min = Math.round((Date.now() - t0) / 60_000);
  log(`\n結果: ${min} 分時点で state=${entry.state} 接続あり=${entry.session !== undefined}`);
} catch (e) {
  log(`例外: ${e?.stack ?? e}`);
} finally {
  try { if (entry) await sessions.close(entry.id); } catch { /* 良い */ }
}
