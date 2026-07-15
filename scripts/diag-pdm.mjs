// PDM「Work with Members Using PDM」画面のフィールド／属性を採取し、下線が長く出る原因を調べる。
// 実行: node --env-file=.env scripts/diag-pdm.mjs
import { Session5250, TcpTransport } from "@as400web/core";

const log = (s) => process.stderr.write(s + "\n");
const user = process.env.PUB400_USER;
const password = process.env.PUB400_PASSWORD;

const real = await TcpTransport.connect({ host: process.env.PUB400_HOST ?? "pub400.com", port: 23 });
const recv = [];
let capturing = false;
const wrapped = {
  start: () => real.start?.(),
  send: (data) => real.send(data),
  onData: (fn) =>
    real.onData((data) => {
      if (capturing) recv.push(Uint8Array.from(data));
      fn(data);
    }),
  onClose: (fn) => real.onClose(fn),
  onError: (fn) => real.onError?.(fn),
  close: () => real.close()
};

const session = await Session5250.connect({
  transport: wrapped,
  deviceName: process.env.PUB400_DEVNAME ?? "WEBPDM1",
  user,
  password
});

const text = (snap) => snap.cells.map((r) => r.map((c) => c.char).join("").replace(/ +$/, "")).join("\n");
const findCmd = (snap) => snap.fields.find((f) => !f.protected && f.row >= 19) ?? snap.fields.find((f) => !f.protected);

function dumpFields(snap, label) {
  log(`\n===== ${label} =====`);
  snap.cells.slice(0, 12).forEach((row, i) => {
    const t = row.map((c) => c.char).join("").replace(/ +$/, "");
    if (t) log(String(i + 1).padStart(2) + "|" + t);
  });
  log("--- fields ---");
  for (const f of snap.fields) {
    log(`  #${f.index} (${f.row},${f.col}) len=${f.length} ${f.protected ? "protected" : "INPUT"} ${f.hidden ? "hidden" : ""}`);
  }
  // 下線属性を持つセルの範囲（行ごと）
  log("--- underline 属性セル ---");
  snap.cells.forEach((row, r) => {
    const cols = [];
    row.forEach((c, i) => {
      if (c.underline) cols.push(i + 1);
    });
    if (cols.length) log(`  row ${r + 1}: cols ${cols[0]}..${cols[cols.length - 1]} (${cols.length} 桁)`);
  });
}

// signon → menu（メッセージ画面が出たら Enter で進める）
let snap = session.snapshot();
log("初期画面 先頭行: " + text(snap).split("\n").slice(0, 3).join(" / "));
for (let i = 0; i < 3 && !findCmd(snap); i++) {
  const rr = await session.sendAid("Enter", { timeoutMs: 8000 });
  snap = rr.screen;
  log(`Enter#${i + 1} 後 先頭行: ` + text(snap).split("\n").slice(0, 2).join(" / "));
}

// STRPDM
let cmd = findCmd(snap);
if (!cmd) {
  log("コマンド入力欄が見つかりません。fields:");
  for (const f of snap.fields) log(`  #${f.index} (${f.row},${f.col}) len=${f.length} ${f.protected ? "prot" : "INPUT"}`);
  session.disconnect();
  process.exit(1);
}
session.setField({ index: cmd.index }, "STRPDM");
let r = await session.sendAid("Enter", { timeoutMs: 8000 });
snap = r.screen;
log("STRPDM 後: " + (text(snap).split("\n").find((l) => /PDM|Development/i.test(l)) ?? "?"));

// PDM メニューで "3"（Work with members）
const sel = snap.fields.find((f) => !f.protected);
if (sel) {
  session.setField({ index: sel.index }, "3");
  r = await session.sendAid("Enter", { timeoutMs: 8000 });
  snap = r.screen;
}
dumpFields(snap, "Specify Members to Work With");

// File/Library をセットして Enter → メンバー一覧へ
const fFile = snap.fields.find((f) => !f.protected && f.row === 5);
const fLib = snap.fields.find((f) => !f.protected && f.row === 7);
if (fFile) session.setField({ index: fFile.index }, "QRPGSRC");
if (fLib) session.setField({ index: fLib.index }, process.env.PUB400_LIB ?? "MYLIB");
recv.length = 0;
capturing = true;
r = await session.sendAid("Enter", { timeoutMs: 8000 });
capturing = false;
snap = r.screen;
dumpFields(snap, "Work with Members Using PDM（メンバー一覧）");

// 生 WTD をダンプ（row 3 付近の属性配置を見る）
const hex = (u8) => [...u8].map((b) => b.toString(16).padStart(2, "0")).join("");
log("\n--- メンバー一覧の生受信データ ---");
for (const chunk of recv) log(hex(chunk));

session.disconnect();
process.exit(0);
