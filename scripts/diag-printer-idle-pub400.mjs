// **pub400 でも常駐プリンターがアイドルを越えられるか**（backlog `hostserver.md`）。
//
// 実機（LAN）では修正前 15 分で死に、修正後 50 分を越えた。
// **pub400 はインターネット越しの別経路**なので、そこでも成り立つかは別の話。
//
// ⚠ **装置名は明示する。** 自動採番（`QPADEV0003` 等）だと**採番された名前を読み出せない**
// （`deviceName` は入力専用）ので、待ち行列もライターも指定できない。
// pub400 は自動構成が効くので、こちらで決めた名前がそのまま作られる。
//
// ⚠ **ライターは自動では上がらない。** プリンターセッションを繋いだだけでは
// スプールが `READY` のまま溜まる（実機版と同じ。一度これで測り損ねた）。
//
// ⚠ **共有の公開機なので掃除コマンドは打たない**（`CLROUTQ` / `ENDWTR` を無条件に撃たない）。
// 装置はセッションごとに作られるので、前の実行の残骸は残らない。
//
// 実行: IDLE_MIN=30 node --env-file=.env --env-file=.env.verify scripts/diag-printer-idle-pub400.mjs
import { appendFileSync } from "node:fs";
import { SessionManager } from "@ts5250/server";
import { CommandConnection, DbConnection } from "@ts5250/hostserver";

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

const cred = { host, user, password };
const device = process.env.PUB400_PRTDEV ?? "PRTIDLE1";

const sessions = new SessionManager();
let db, cc, entry;
try {
  db = await DbConnection.connect(cred);
  entry = await sessions.openPrinter({ ...cred, deviceName: device, service: true });
  if (entry.resident !== true) throw new Error("常駐になっていない");
  entry.onReport = undefined;
  await sleep(3000);
  log(`常駐 id=${entry.id} 装置=${device} 起動応答=${entry.session?.startupCode ?? "?"}`);

  cc = await CommandConnection.connect(cred);
  // **ライターを起こす**（自動では上がらない）
  const w = await cc.run(`STRPRTWTR DEV(${device}) OUTQ(${device})`);
  log(`  STRPRTWTR rc=${w.returnCode} ${(w.messages ?? []).map((m) => m.id).join(",") || ""}`);
  await cc.run(`CHGJOB OUTQ(${device})`);

  /** 1 件流して届くまで待つ */
  const send = async (waitMs) => {
    const n = entry.reports.length;
    await cc.run("DSPLIBL OUTPUT(*PRINT)");
    const t0 = Date.now();
    while (Date.now() - t0 < waitMs && entry.reports.length === n) await sleep(1000);
    return { got: entry.reports.length - n, ms: Date.now() - t0 };
  };

  const c = await send(90_000);
  log(`対照: 受信 ${c.got} 件 / ${Math.round(c.ms / 1000)}s`);
  if (c.got === 0) throw new Error("アイドル前から届かない（前提が崩れている）");

  log(`\n### ${IDLE_MIN} 分のアイドル（**何も送らない**）`);
  await sleep(IDLE_MIN * 60_000);

  log(`\n### アイドル明け`);
  log(`  こちら側: state=${entry.state} 接続あり=${entry.session !== undefined}`);
  const a = await send(90_000);
  log(`  流したあと: 受信 ${a.got} 件 / ${Math.round(a.ms / 1000)}s / state=${entry.state}`);

  log("\n### 判定");
  if (a.got >= 1) log(`  **越えられた**——${IDLE_MIN} 分のアイドル後も届く`);
  else log("  **届かない**——この経路でも落ちる");
} catch (e) {
  log(`例外: ${e?.message ?? e}`);
} finally {
  try { if (entry) await sessions.close(entry.id); } catch { /* 良い */ }
  // **自分が起こしたライターは止める**（掴んだままにしない）。
  // ⚠ 共有機なので `CLROUTQ` は打たない——自分の装置の待ち行列だけを対象に、
  //    残ったスプールはライターが消費するか、そのまま残す
  try { if (cc) await cc.run(`ENDWTR WTR(${device}) OPTION(*IMMED)`); } catch { /* 良い */ }
  cc?.close?.();
  try { db?.close(); } catch { /* 良い */ }
}
