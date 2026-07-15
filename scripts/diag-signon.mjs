// 手動 field-signon の送出バイト診断。
//   自動サインオンなしで PUB400 に接続 → signon 画面のフィールド構造を出力 →
//   user/password をセットして Enter 時に送出する Read 応答レコードを採取・16 進ダンプする。
// 実行: node --env-file=.env scripts/diag-signon.mjs
import { Session5250, TcpTransport } from "@as400web/core";

const log = (s) => process.stderr.write(s + "\n");
const user = process.env.PUB400_USER ?? "USER";
const password = process.env.PUB400_PASSWORD ?? "";
const host = process.env.PUB400_HOST ?? "pub400.com";

const real = await TcpTransport.connect({ host, port: 23 });
const sent = [];
const recv = [];
const wrapped = {
  start: () => real.start?.(),
  send: (data) => {
    sent.push(Uint8Array.from(data));
    real.send(data);
  },
  onData: (fn) =>
    real.onData((data) => {
      recv.push(Uint8Array.from(data));
      fn(data);
    }),
  onClose: (fn) => real.onClose(fn),
  onError: (fn) => real.onError?.(fn),
  close: () => real.close()
};

// 自動サインオンなし（user/password を渡さない）
const session = await Session5250.connect({ transport: wrapped, id: "diag", deviceName: process.env.PUB400_DEVNAME ?? "WEBEMU01" });
log(`state=${session.currentState}`);
let snap = session.snapshot();

// signon 画面のテキストとフィールド構造
log("--- 画面（先頭 8 行）---");
snap.cells.slice(0, 8).forEach((row, i) => {
  const t = row.map((c) => c.char).join("").replace(/ +$/, "");
  if (t) log(String(i + 1).padStart(2) + "|" + t);
});
log("--- fields ---");
for (const f of snap.fields) {
  log(`  #${f.index} (${f.row},${f.col}) len=${f.length} ${f.protected ? "protected" : "input"} ${f.hidden ? "hidden" : ""} value=${JSON.stringify(f.value)}`);
}

// signon 画面を組んだ受信データから Read コマンド種別を探す（ESC=0x04 の次バイト）
const READ_NAMES = { 0x42: "READ_INPUT_FIELDS", 0x52: "READ_MDT_FIELDS", 0x82: "READ_MDT_FIELDS_ALT", 0x06: "READ_IMMEDIATE" };
const allRx = [];
for (const chunk of recv) for (const b of chunk) allRx.push(b);
const reads = [];
for (let i = 0; i < allRx.length - 1; i++) {
  if (allRx[i] === 0x04 && READ_NAMES[allRx[i + 1]]) reads.push(READ_NAMES[allRx[i + 1]] + `(0x${allRx[i + 1].toString(16)})`);
}
log("--- 受信データ中の Read コマンド ---");
log("  " + (reads.length ? reads.join(", ") : "(検出なし)"));

// user/password をセット（入力フィールドの先頭2つ）
const inputs = snap.fields.filter((f) => !f.protected);
if (inputs.length >= 2) {
  session.setField({ index: inputs[0].index }, user);
  session.setField({ index: inputs[1].index }, password);
  log(`set user=#${inputs[0].index}(${JSON.stringify(user)}) password=#${inputs[1].index}(len ${password.length})`);
}

const before = sent.length;
await session.sendAid("Enter", { timeoutMs: 8000 }).catch((e) => log("sendAid: " + e.message));

// Enter で送出したレコード（before 以降）を採取
const hex = (u8) => [...u8].map((b) => b.toString(16).padStart(2, "0")).join("");
for (let i = before; i < sent.length; i++) {
  log(`--- 送出レコード[${i}] (${sent[i].length} bytes) ---`);
  log(hex(sent[i]));
}

// 応答画面（CPF メッセージ等）
snap = session.snapshot();
if (snap.systemMessage) log("systemMessage: " + snap.systemMessage);
const msgRow = snap.cells.map((r) => r.map((c) => c.char).join("").replace(/ +$/, "")).filter((t) => /CPF\d|Sign|sign|password|user/i.test(t));
log("--- 応答の要点行 ---");
msgRow.slice(0, 6).forEach((t) => log("  " + t));

session.disconnect();
process.exit(0);
