// Attn / SysReq を実機で確かめる（本体の実装をそのまま通す）。
//
// 背景（tn5250j の tnvt.systemRequest / cancelInvite を逆アセンブルして得た事実）:
//   1) 端末 → ホスト: Attn は ATN フラグ、SysReq は SRQ フラグ ＋ システム要求行の文字列（EBCDIC）
//   2) ホスト → 端末: opcode 0x0A（Cancel Invite）
//   3) 端末 → ホスト: opcode 0x0A・フラグ 0・データ無し（**受け取りの返事**）
//   4) ホスト → 端末: SAVE SCREEN → ATNPGM の窓／システム要求メニュー
// 3) は `Session5250.handleRecord` が返す。**この script は手で ack を足さない**——
// 足すと本体が壊れていても通ってしまい、実機検証の意味が無くなる。
//
// 実行: node --env-file=.env --env-file=.env.verify scripts/probe-sysreq.mjs [SysReq に打つ文字列]
//   SRQ_ATTN=1     … SysReq ではなく Attn を送る（画面下部のコマンド入力欄を見る）
//   SRQ_SYS=pub400 … 接続先システム名（既定実機）
//   SRQ_DEV=…      … 装置名。実機は事前定義された名前しか受け付けず QPADEV000x のみ自動作成が通る。
//                    切断されたジョブが残るので、同じ名前を続けて使うと「対話式ジョブの回復」画面が出る
import { readFileSync } from "node:fs";
import { Session5250 } from "@ts5250/tn5250";
import { parseRecord } from "../packages/tn5250/dist/protocol/gds.js";
import { SecretCrypto } from "../packages/server/dist/secret-crypto.js";

const log = (s) => process.stderr.write(s + "\n");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const REQUEST = process.argv[2] ?? "";
const ATTN = process.env.SRQ_ATTN === "1";

const cfg = JSON.parse(readFileSync("connections.json", "utf8"));
const sys = cfg.systems.find((s) => s.name === (process.env.SRQ_SYS ?? process.env.AS400_SYSTEM ?? "AS400"));
const crypto = SecretCrypto.fromEnv();
const password = crypto.decrypt(sys.signon.passwordEnc);

const session = await Session5250.connect({
  host: sys.host,
  port: sys.port ?? 23,
  deviceName: process.env.SRQ_DEV ?? "QPADEV0009",
  screenSize: "24x80",
  ccsid: sys.ccsid ?? 939,
  warn: (m) => log("WARN " + m)
});

// ホストとの往復を覗くだけ（**応答はしない**。それは本体の仕事）
const inner = session.telnet.recordFn;
session.telnet.onRecord((rec) => {
  const p = parseRecord(rec);
  log(`<<< opcode=0x${p.opcode.toString(16).padStart(2, "0")} data=${p.data.length}B`);
  inner(rec);
});

const text = (snap) => snap.cells.map((r) => r.map((c) => c.char).join("").replace(/ +$/, ""));
function dump(snap, label) {
  log(`\n===== ${label} =====`);
  log(`cursor=(${snap.cursor.row},${snap.cursor.col}) fields=${snap.fields.length}`);
  text(snap).forEach((t, i) => {
    if (t) log(String(i + 1).padStart(2) + "|" + t);
  });
  for (const f of snap.fields) {
    log(
      `  #${f.index} (${f.row},${f.col}) len=${f.length} ` +
        `${f.protected ? "prot" : "INPUT"} value=${JSON.stringify(f.value)}`
    );
  }
}

const findCmd = (snap) =>
  snap.fields.find((f) => !f.protected && f.row >= 19) ?? snap.fields.find((f) => !f.protected);

// サインオン〜メインメニュー（RFC4777 自動サインオンは効かない設定なので手で埋める）
let snap = session.snapshot();
if (text(snap).some((t) => /サイン・オン|サインオン|Sign On/i.test(t))) {
  const inputs = snap.fields.filter((f) => !f.protected);
  if (inputs[0]) session.setField({ index: inputs[0].index }, sys.signon.user);
  if (inputs[1]) session.setField({ index: inputs[1].index }, password);
  await session.sendAid("Enter", { timeoutMs: 12000 });
  await sleep(900);
  snap = session.snapshot();
}
for (let i = 0; i < 4 && !findCmd(snap); i++) {
  await session.sendAid("Enter", { timeoutMs: 8000 });
  await sleep(700);
  snap = session.snapshot();
}
dump(snap, "起点（メインメニュー）");

// **sendAid が解決すること自体が ack の証拠**。ack を返さないとホストが止まり、
// キーボードが解除されないのでここでタイムアウトする。
log(ATTN ? "\n>>> Attn" : `\n>>> SysReq ${JSON.stringify(REQUEST)}`);
const r = ATTN
  ? await session.sendAid("Attn", { timeoutMs: 10000 })
  : await session.sendAid("SysReq", { timeoutMs: 10000, sysReqText: REQUEST });
log(`sendAid timedOut=${r.timedOut}`);
await sleep(800);
dump(session.snapshot(), ATTN ? "Attn の後（ATNPGM の窓）" : "SysReq の後");

// ATNPGM の窓でコマンドを実行する（利用者の本題＝「画面下部の入力欄でコマンドが打てる」）
if (ATTN && process.env.SRQ_CMD) {
  const cmdField = session.snapshot().fields.find((f) => !f.protected);
  session.setField({ index: cmdField.index }, process.env.SRQ_CMD);
  await session.sendAid("Enter", { timeoutMs: 10000 });
  await sleep(1200);
  dump(session.snapshot(), `コマンド ${process.env.SRQ_CMD} の実行結果`);
  await session.sendAid("F3", { timeoutMs: 8000 });
  await sleep(900);
}

// F3 で戻す（ホストは RESTORE SCREEN で背面を戻すはず）
await session.sendAid("F3", { timeoutMs: 8000 });
await sleep(1200);
dump(session.snapshot(), "F3 後（背面の復元）");

session.disconnect();
process.exit(0);
