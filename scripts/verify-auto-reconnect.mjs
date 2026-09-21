// **ホストに切られたら自動で繋ぎ直すか**を実機で確かめる（`20260921-auto-reconnect`）。
//
// コアの `Session5250` を `autoReconnect: true` で実機へ繋ぎ、サインオンしてから
// `SIGNOFF ENDCNN(*YES)` でホストに切らせる。ACS（ECL の自動再接続）は 3 秒以内に新しい
// サインオン画面へ戻った（`scripts/acs-probe/signoff-endcnn-reconnect.txt`）。同じになるかを見る。
//
// 実行: node --env-file=.env --env-file=.env.verify scripts/verify-auto-reconnect.mjs
//   VERIFY_CMD でホストに打つコマンドを替えられる（既定 `SIGNOFF ENDCNN(*YES)`）。
//   `SIGNOFF`（ENDCNN(*NO)）はホストが接続を切らないので、**繋ぎ直しが起きないこと**を見る対照になる。
//   AS400_HOST / AS400_USER / AS400_PASSWORD（`.env`）。資格情報は画面にもログにも出さない。
//   装置名は既定で指定しない（ホスト採番）。`VERIFY_USE_DEVNAME=1` なら `.env.verify` の AS400_DEVNAME で固定する
//   ——固定した装置名で、切られた直後に同じ名前で繋ぎ直せるかを見る。`VERIFY_DEVNAME` で直接指定もできる
//   （新しい装置名は自動構成が効かないことがあるので、既存スクリプトが使い回す名前を使う。AGENTS.md）。
import { Session5250 } from "@ts5250/tn5250";

const host = process.env.AS400_HOST, user = process.env.AS400_USER, password = process.env.AS400_PASSWORD;
if (!host || !user || !password) {
  process.stderr.write("AS400_HOST / AS400_USER / AS400_PASSWORD が要ります（.env）\n");
  process.exit(2);
}
const ccsid = Number(process.env.AS400_CCSID ?? 930);
const log = (s) => process.stderr.write(`${new Date().toISOString().slice(11, 23)} ${s}\n`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rows = (snap) => snap.cells.map((r) => r.map((c) => c.char).join("").replace(/\s+$/, ""));
const head = (snap) => rows(snap).filter(Boolean).slice(0, 3).join(" | ").slice(0, 160);
/** 入力欄のうち画面上で最初のもの（サインオン画面ならユーザー欄） */
const inputsOf = (snap) => snap.fields.filter((f) => !f.protected);

const deviceName = process.env.VERIFY_DEVNAME ?? (process.env.VERIFY_USE_DEVNAME === "1" ? process.env.AS400_DEVNAME : undefined);
const s = await Session5250.connect({
  host, ccsid, autoReconnect: true, warn: (w) => log("WARN: " + w),
  ...(deviceName ? { deviceName } : {})
});
const events = [];
s.on("reconnecting", (e) => { events.push(`reconnecting#${e.attempt}`); log(`EVENT reconnecting attempt=${e.attempt} reason=${e.reason}`); });
s.on("reconnected", (st) => { events.push("reconnected"); log(`EVENT reconnected device=${st?.device ?? "?"} code=${st?.code ?? "?"}`); });
s.on("closed", (r) => { events.push("closed"); log(`EVENT closed ${r}`); });
log(`connected device=${s.startup?.device ?? "?"}: ${head(s.snapshot())}`);

// サインオン（ユーザー欄・パスワード欄の 2 つを埋める）
await sleep(800);
let inputs = inputsOf(s.snapshot());
s.setField({ index: inputs[0].index }, user);
s.setField({ index: inputs[1].index }, password);
await s.sendAid("Enter", { cursor: { row: inputs[0].row, col: inputs[0].col }, timeoutMs: 15000 });
// 途中の画面（サインオン情報・ジョブの回復）を Enter で抜けてコマンド行まで
for (let i = 0; i < 6; i++) {
  await sleep(800);
  const t = rows(s.snapshot());
  if (t.some((r) => /===>/.test(r))) break;
  if (t.some((r) => r.includes("対話式ジョブの回復"))) {
    const f = inputsOf(s.snapshot()).slice(-1)[0];
    s.setField({ index: f.index }, "90");
    await s.sendAid("Enter", { cursor: { row: f.row, col: f.col }, timeoutMs: 12000 });
  } else {
    await s.sendAid("Enter", { timeoutMs: 10000 });
  }
}
log(`signed on: ${head(s.snapshot())}`);

// ホストに切らせる
const cmd = inputsOf(s.snapshot()).find((f) => f.length >= 50) ?? inputsOf(s.snapshot()).slice(-1)[0];
const verifyCmd = process.env.VERIFY_CMD ?? "SIGNOFF ENDCNN(*YES)";
log(`command: ${verifyCmd}`);
s.setField({ index: cmd.index }, verifyCmd);
const t0 = Date.now();
void s.sendAid("Enter", { cursor: { row: cmd.row, col: cmd.col }, timeoutMs: "never" }).catch(() => {});
// 繋ぎ直して新しいサインオン画面が出るまで（最大 60 秒）
const waitMs = Number(process.env.VERIFY_WAIT_MS ?? 60000);
for (let i = 0; i < waitMs / 500 && !events.includes("reconnected") && !events.includes("closed"); i++) await sleep(500);
await sleep(1500);
const snap = s.snapshot();
log(`after ${((Date.now() - t0) / 1000).toFixed(1)}s state=${s.currentState} keyboardLocked=${snap.keyboardLocked} device=${s.startup?.device ?? "?"}`);
log(`screen: ${head(snap)}`);
log(`events: ${events.join(",")}`);
const signonAgain = inputsOf(snap).length >= 2 && s.currentState === "ready";
const reconnected = events.includes("reconnected");
log(`RESULT: reconnected=${reconnected} signonScreen=${signonAgain}`);
s.disconnect();
await sleep(500);
process.exit(0);
