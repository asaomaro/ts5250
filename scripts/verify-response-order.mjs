// 実機検証: **1 本のレコードの中の応答をコマンドの順に送る・SAVE SCREEN のオペコードのレコードは退避だけ**（`20260928-response-order`）。
//
// 当 PJ のコア（dist）を実機へ繋ぎ、DSM の RESPORDER（オペコード 03 の [WSF Query][SAVE SCREEN]）と RESPORDER2（オペコード 04 の [SAVE SCREEN][WSF Query]）を
// 出させて、送った応答の並びを ACS のワイヤ（`scripts/acs-probe/response-order.txt`: RESPORDER は Query → 退避、RESPORDER2 は退避だけ）と比べる。
//
// 前提: npm run build ／ DSCMD_LIB=<AS400_LIB> node --env-file=.env --env-file=.env.verify scripts/build-dscmd.mjs
// 実行: node --env-file=.env --env-file=.env.verify scripts/verify-response-order.mjs
// **終わったら DLTPGM と IFS の /tmp/dscmd.c・/tmp/dscmd.log を消す**。
import { Session5250 } from "@ts5250/tn5250";

const host = process.env.AS400_HOST;
const user = process.env.AS400_USER;
const password = process.env.AS400_PASSWORD;
if (!host || !user || !password) { process.stderr.write("AS400_* が要ります\n"); process.exit(2); }
const LIB = (process.env.AS400_LIB ?? "TESTLIB").trim().split(/\s+/)[0];
const log = (s) => process.stderr.write(s + "\n");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const session = await Session5250.connect({ host, port: 23, ccsid: 5035, screenSize: "24x80", warn: () => {} });
const telnet = session.telnet;
const outbound = [];
const innerSend = telnet.sendRecord.bind(telnet);
telnet.sendRecord = (rec) => { outbound.push(rec); return innerSend(rec); };
const text = () => session.snapshot().cells.map((r) => r.map((c) => c.char).join("")).join("\n");
const inputs = () => session.snapshot().fields.filter((f) => !f.protected);

for (let i = 0; i < 8; i++) {
  const t = text();
  if (t.includes("コマンドを入力") || t.includes("選択項目またはコマンド")) break;
  const f = inputs();
  if (t.includes("サイン・オン")) {
    if (f[0]) session.setField({ index: f[0].index }, user);
    if (f[1]) session.setField({ index: f[1].index }, password);
  } else if (t.includes("回復") && f[0]) session.setField({ index: f[0].index }, "90");
  await session.sendAid("Enter", { timeoutMs: 15000 });
  await sleep(900);
}

/** 送ったレコードの種類（GDS ヘッダ 10 バイトの後ろ: Query の応答 `00 00 88`・退避の応答 `04 12`） */
const kind = (rec) => (rec[10] === 0x00 && rec[11] === 0x00 && rec[12] === 0x88 ? "query" : rec[10] === 0x04 && rec[11] === 0x12 ? "save" : `other(${rec[10]?.toString(16)} ${rec[11]?.toString(16)})`);
let pass = 0, fail = 0;
const check = (c, m) => { if (c) { pass++; log(`  PASS ${m}`); } else { fail++; log(`  FAIL ${m}`); } };

for (const [pgm, want] of [["RESPORDER", ["query", "save"]], ["RESPORDER2", ["save"]]]) {
  const cmd = inputs().find((f) => f.length > 20);
  if (!cmd) { log("コマンド欄が見つからない"); break; }
  session.setField({ index: cmd.index }, `CALL ${LIB}/DSCMD PARM('${pgm}')`);
  const at = outbound.length + 1; // CALL の Enter の後ろ
  await session.sendAid("Enter", { timeoutMs: 25000 }).catch(() => {});
  await sleep(4000);
  const got = outbound.slice(at).map(kind).filter((k) => k === "query" || k === "save");
  check(JSON.stringify(got) === JSON.stringify(want), `${pgm}: ${JSON.stringify(got)}（ACS: ${JSON.stringify(want)}）`);
  // DSM の 2 回目の読み（READ INPUT）を Enter で抜ける
  await session.sendAid("Enter", { timeoutMs: 15000 }).catch(() => {});
  await sleep(2500);
}
const cmd = inputs().find((f) => f.length > 20);
if (cmd) { session.setField({ index: cmd.index }, "SIGNOFF"); await session.sendAid("Enter", { timeoutMs: 10000 }).catch(() => {}); }
session.disconnect();
log(`RESULT: pass=${pass} fail=${fail}`);
process.exit(fail > 0 ? 1 : 0);
