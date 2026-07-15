// T13: PUB400 実機検証 — サインオン → メニュー → signoff の往復と trace 採取。
// 実行: node --env-file=.env scripts/verify-signon.mjs
// trace は maskTx 既定 ON（パスワードを含む送信データは伏字化して保存）。
import { writeFileSync, appendFileSync } from "node:fs";
import { Session5250, TcpTransport, TraceRecorder } from "@as400web/core";

const user = process.env.PUB400_USER;
const password = process.env.PUB400_PASSWORD;
if (!user || !password) {
  process.stderr.write("PUB400_USER / PUB400_PASSWORD が未設定です（--env-file=.env）\n");
  process.exit(1);
}
const host = process.env.PUB400_HOST ?? "pub400.com";
const out = process.argv[2] ?? "packages/core/test/fixtures/pub400-signon-to-menu.jsonl";
const log = (s) => process.stderr.write(s + "\n");

writeFileSync(out, "");
const rec = new TraceRecorder((l) => appendFileSync(out, l + "\n")); // maskTx: true（既定）

const inner = await TcpTransport.connect({ host, port: 23 });
const tracing = {
  send(d) {
    rec.tx(d);
    inner.send(d);
  },
  close() {
    inner.close();
  },
  onData(fn) {
    inner.onData((d) => {
      rec.rx(d);
      fn(d);
    });
  },
  onClose(fn) {
    inner.onClose(fn);
  },
  onError(fn) {
    inner.onError(fn);
  }
};

function printScreen(snap, label) {
  log(`--- ${label} --- cursor=(${snap.cursor.row},${snap.cursor.col}) fields=${snap.fields.length}${snap.systemMessage ? ` msg="${snap.systemMessage}"` : ""}`);
  snap.cells.forEach((row, i) => {
    const text = row.map((c) => c.char).join("").replace(/ +$/, "");
    if (text !== "") log(String(i + 1).padStart(2) + "|" + text);
  });
}

const screenText = (snap) => snap.cells.map((r) => r.map((c) => c.char).join("")).join("\n");

let closedReason = null;
const session = await Session5250.connect({ transport: tracing, id: "t13", warn: (w) => log(`WARN: ${w}`) });
session.on("closed", (r) => (closedReason = r));
log(`connected: state=${session.currentState}`);
printScreen(session.snapshot(), "signon screen");

// サインオン（フィールド検出ベース: 最初の非 hidden=ユーザー、最初の hidden=パスワード）
const fields = session.snapshot().fields;
const userField = fields.find((f) => !f.protected && !f.hidden);
const passField = fields.find((f) => !f.protected && f.hidden);
if (!userField || !passField) {
  log("サインオン画面のフィールド検出に失敗");
  process.exit(1);
}
session.setField({ index: userField.index }, user);
session.setField({ index: passField.index }, password);
let r = await session.sendAid("Enter", { timeoutMs: 20000 });
printScreen(r.screen, `after Enter (timedOut=${r.timedOut})`);

// サインオン失敗（CPF エラー）は即中断する（再試行はプロファイル無効化 QMAXSIGN の危険がある）
if (/CPF\d{4}/.test(screenText(r.screen))) {
  log("signon rejected by host (CPFxxxx) — aborting without retry");
  session.disconnect();
  process.exit(1);
}

// 中間画面（プログラムメッセージ表示等）は Enter で最大 3 回進める
for (let i = 0; i < 3 && !/MAIN|Main Menu/i.test(screenText(r.screen)); i++) {
  if (/CPF\d{4}/.test(screenText(r.screen))) break;
  log("intermediate screen — sending Enter");
  r = await session.sendAid("Enter", { timeoutMs: 20000 });
  printScreen(r.screen, `after Enter #${i + 2} (timedOut=${r.timedOut})`);
}

const onMenu = /MAIN|Main Menu/i.test(screenText(r.screen));
log(`menu reached: ${onMenu}`);

if (onMenu) {
  // コマンド行に signoff を入れて Enter（ホスト側がセッションを閉じる）
  const cmd = r.screen.fields.find((f) => !f.protected && !f.hidden);
  if (cmd) {
    session.setField({ index: cmd.index }, "signoff");
    const off = await session.sendAid("Enter", { timeoutMs: 15000 });
    log(`signoff sent (timedOut=${off.timedOut}) state=${session.currentState}`);
  }
}
await new Promise((res) => setTimeout(res, 1500));
log(`closed=${closedReason ?? "(open)"} state=${session.currentState}`);
session.disconnect();
log(`trace saved: ${out}`);
log(onMenu ? "T13: OK" : "T13: NG (menu not reached)");
process.exit(onMenu ? 0 : 1);
