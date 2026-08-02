// 実機で「SEU のソース行に埋め込まれた属性（制御コード）が、
// 制御コードに触れない編集をして保存しても失われない」ことを確かめる。
//
// 前提: TESTLIB/QCLRTEST(ATTRTEST) の 1 行目に  C1C2C3 28 C4C5C6  が入っていること
//       （ABC + 属性 0x28(赤) + DEF）。作り方は PR の検証手順を参照。
//
// 実行: AS400_HOST=... AS400_USER=... AS400_PASSWORD=... node scripts/verify-seu-attr.mjs
// パスワードは環境変数からのみ受け取る（引数はプロセス一覧に見えるため）。
import { Session5250, TcpTransport } from "@ts5250/tn5250";

const log = (s) => process.stderr.write(s + "\n");
const host = process.env.AS400_HOST;
const user = process.env.AS400_USER;
const password = process.env.AS400_PASSWORD;
if (!host || !user || !password) {
  log("AS400_HOST / AS400_USER / AS400_PASSWORD を環境変数で指定してください");
  process.exit(1);
}

// 装置名は毎回変える（使い回すと前ジョブの回復画面が出る）
const dev = process.env.AS400_DEVNAME ?? "DEV1"; // 実機に定義済みの仮想装置（任意名の自動構成は効かない）

const transport = await TcpTransport.connect({ host, port: 23 });
const session = await Session5250.connect({ transport, deviceName: dev, user, password, screenSize: "27x132", ccsid: 939 });

const text = (snap) => snap.cells.map((r) => r.map((c) => c.char).join("").replace(/ +$/, "")).join("\n");
const show = (snap, label, rows = 24) => {
  log(`\n===== ${label} =====`);
  snap.cells.slice(0, rows).forEach((row, i) => {
    const t = row.map((c) => c.char).join("").replace(/ +$/, "");
    if (t) log(String(i + 1).padStart(2) + "|" + t);
  });
};
/** 属性セル（kind:"attr"）と色の分布を行ごとに出す */
const attrMap = (snap) => {
  const out = [];
  snap.cells.forEach((row, r) => {
    row.forEach((c, i) => {
      if (c.kind === "attr") out.push(`行${r + 1}桁${i + 1}(rawByte=0x${(c.rawByte ?? 0).toString(16)})`);
    });
  });
  return out;
};
async function enter(ms = 12000) {
  return await session.sendAid("Enter", { timeoutMs: ms });
}

// --- 画面に応じて進める（サインオン / 前ジョブ回復 / メッセージ）---
let snap = session.snapshot();
/** コマンド入力行（下部の長い入力欄） */
const cmdLine = (sn) => sn.fields.find((f) => !f.protected && f.row >= 15 && f.length >= 40);

for (let step = 0; step < 10; step++) {
  const t = text(snap);
  if (cmdLine(snap)) break;
  if (t.includes("回復") || t.includes("Recovery")) {
    // 前回の中断が残っている。90 = 前の対話式ジョブのサインオフ で綺麗にする
    const sel = snap.fields.filter((f) => !f.protected).pop();
    if (sel) session.setField({ index: sel.index }, "90");
    await enter(20000);
  } else if (t.includes("サイン・オン") || t.toUpperCase().includes("SIGN ON")) {
    const inputs = snap.fields.filter((f) => !f.protected);
    if (inputs.length >= 2) {
      session.setField({ index: inputs[0].index }, user);
      session.setField({ index: inputs[1].index }, password);
    }
    await enter(25000);
  } else {
    await enter(15000); // メッセージ画面など
  }
  snap = session.snapshot();
}
show(snap, "コマンド行に到達", 24);

const cmd = cmdLine(snap);
if (!cmd) {
  log("コマンド行が見つかりません");
  session.disconnect();
  process.exit(1);
}

// --- STRSEU でメンバーを開く ---
session.setField({ index: cmd.index }, "STRSEU SRCFILE(TESTLIB/QJPNTEST) SRCMBR(JPNATTR) OPTION(2)");
await enter(30000);
snap = session.snapshot();
// 前回の中断が残ると「SEU メンバーの回復」画面が出る。2 = 前回の変更を廃棄して新規セッション
if (text(snap).includes("メンバーの回復")) {
  const sel = snap.fields.filter((f) => !f.protected).pop();
  if (sel) session.setField({ index: sel.index }, "2");
  await enter(25000);
  snap = session.snapshot();
  log("(SEU メンバー回復画面を 2 で抜けた)");
}
show(snap, "STRSEU 直後");
log("属性セル: " + JSON.stringify(attrMap(snap)));
log("入力欄(先頭6): " + JSON.stringify(snap.fields.filter((f) => !f.protected).slice(0, 6)
  .map((f) => ({ i: f.index, row: f.row, col: f.col, len: f.length, dbcs: f.dbcsType }))));

// --- ソース行を編集して保存する（制御コードには触らない）---
const targetRow = Number(process.env.SEU_ROW ?? 5);
const srcLine = snap.fields.find((f) => !f.protected && f.row === targetRow && f.length >= 50);
if (!srcLine) {
  log("ソース行の入力欄が見つかりません");
  session.disconnect();
  process.exit(1);
}
const before = srcLine.value;
const cp = (ch) => ch.codePointAt(0);
log("\n編集前の欄:");
log("  dbcsType = " + String(srcLine.dbcsType));
log("  値の文字コード = " + [...before].slice(0, 10).map((c) => cp(c).toString(16)).join(" "));
log("  センチネル(E020-E03F) を含む = " + [...before].some((c) => cp(c) >= 0xe020 && cp(c) <= 0xe03f));

// 制御コード桁は触らず 2 文字目 B→X（センチネルはそのまま残す）
const edited = [...before].map((ch, i) => (i === 1 ? "X" : ch)).join("");
session.setField({ index: srcLine.index }, edited);
log("  編集後に送る値 = " + [...edited].slice(0, 10).map((c) => cp(c).toString(16)).join(" "));

// F3 で終了 → 確認画面で Enter（保存）
await session.sendAid("F3", { timeoutMs: 25000 });
let s2 = session.snapshot();
show(s2, "F3 直後（終了確認）", 14);
await enter(25000);
s2 = session.snapshot();
show(s2, "保存後", 10);

session.disconnect();
