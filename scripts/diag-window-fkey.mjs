// **DDS の窓が開いている間に無効なファンクション・キーを押したとき、ホストが何を送ってくるか**を見る。
// 窓の中のエラーは WRITE ERROR CODE（0x21）ではなく WRITE ERROR CODE TO WINDOW（0x22）で来る。
// 0x22 が未知コマンド扱いだった頃は、同一レコード後半の READ MDT FIELDS ごと捨てられて
// キーボードがロックしたまま＝「F3 を押すと応答なしでタイムアウト」になっていた（回帰の再現用）。
//
// 検証資材は scripts/build-gridtest3.mjs が作る TESTLIB/GRIDTST5 ＋ GRIDCL7（背景→窓→OVERLAY）。
// CFxx を一切宣言していないので、どのファンクション・キーもホストがエラーで弾く。
//
//   AS400_HOST=... AS400_USER=... AS400_PASSWORD=... AS400_DEVNAME=DEV1 node scripts/diag-window-fkey.mjs
import { Session5250 } from "@as400web/core";

const log = (s) => process.stderr.write(s + "\n");
const host = process.env.AS400_HOST;
const user = process.env.AS400_USER;
const password = process.env.AS400_PASSWORD;
const DEV = process.env.AS400_DEVNAME ?? "GRIDDG1";
const PGM = process.env.DIAG_PGM ?? "GRIDCL7";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let tracing = false;
const session = await Session5250.connect({
  host,
  port: 23,
  ccsid: 939,
  screenSize: process.env.DIAG_SIZE ?? "27x132",
  deviceName: DEV,
  warn: (m) => {
    if (tracing || !m.startsWith("rx record")) log("  [warn] " + m);
  },
  traceRecords: true
});

const text = (snap) =>
  snap.cells.map((r) => r.map((c) => c.char).join("").replace(/ +$/, "")).join("\n");
const dump = (label) => {
  const snap = session.snapshot();
  log(`\n===== ${label} (locked=${session.keyboardLocked}) =====`);
  log(text(snap).split("\n").filter((l) => l.trim() !== "").slice(0, 26).join("\n"));
  log(`  systemMessage: ${snap.systemMessage ?? "(なし)"}`);
  return snap;
};

// --- サインオン〜コマンド行 ---
let snap = session.snapshot();
for (let i = 0; i < 10; i++) {
  const t = text(snap);
  if (t.includes("コマンドを入力") || t.includes("Selection or command")) break;
  const inputs = snap.fields.filter((f) => !f.protected);
  if (t.includes("サイン・オン") || t.includes("Sign On")) {
    session.setField({ index: inputs[0].index }, user);
    session.setField({ index: inputs[1].index }, password);
  } else if (t.includes("回復")) {
    if (inputs[0]) session.setField({ index: inputs[0].index }, "90");
  }
  log(`(進める #${i + 1}: ${t.split("\n").find((l) => l.trim()) ?? ""})`);
  const rr = await session.sendAid("Enter", { timeoutMs: 15000 });
  await sleep(700);
  snap = session.snapshot();
  if (rr.timedOut) log("  …timeout");
}
dump("コマンド行");

// --- テスト画面を呼ぶ ---
const cmdField = session
  .snapshot()
  .fields.filter((f) => !f.protected)
  .find((f) => f.length > 20);
session.setField({ index: cmdField.index }, `CALL TESTLIB/${PGM}`);
await session.sendAid("Enter", { timeoutMs: 20000 });
await sleep(1200);
dump(`CALL TESTLIB/${PGM} 後`);

// --- ここからトレース ON にして F3 ---
tracing = true;
const key = process.env.DIAG_KEY ?? "F3";
log(`\n>>> ${key} を送る`);
const t0 = Date.now();
const r = await session.sendAid(key, { timeoutMs: 12000 });
log(`<<< ${key}: timedOut=${r.timedOut} (${Date.now() - t0}ms) locked=${session.keyboardLocked}`);
await sleep(2000);
dump(`${key} 後`);

// エラーのあと通常操作に戻れるか（窓を閉じて次の画面へ進む）
for (const k of ["F12", "Enter", "Enter"]) {
  const rr = await session.sendAid(k, { timeoutMs: 10000 });
  log(`\n>>> ${k}: timedOut=${rr.timedOut} locked=${session.keyboardLocked}`);
  await sleep(1200);
  dump(`${k} 後`);
}

session.disconnect();
await sleep(300);
process.exit(0);
