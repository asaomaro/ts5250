// 実機検証: **READ SCREEN の応答の中身は、命令の時点の画面か**（`20260929-response-content-timing`）。
//
// 当 PJ のコア（dist）を実機へ繋ぎ、DSM の READSCRTIMING（[READ SCREEN][WTD で (5,10) を OLD→NEW]）と READSCRTIMING2（[WTD][READ SCREEN]。対照）を出させて、
// 送った READ SCREEN の応答（1920 桁の画面）に OLD（D6 D3 C4）・NEW（D5 C5 E6）のどちらが入るかを ACS のワイヤ
// （`scripts/acs-probe/save-timing.txt` の READ SCREEN 版: READSCRTIMING は OLD・READSCRTIMING2 は NEW）と比べる。
//
// 前提: npm run build ／ DSCMD_LIB=<AS400_LIB> node --env-file=.env --env-file=.env.verify scripts/build-dscmd.mjs
// 実行: node --env-file=.env --env-file=.env.verify scripts/verify-read-screen-timing.mjs
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

const OLD = [0xd6, 0xd3, 0xc4], NEW = [0xd5, 0xc5, 0xe6];
const has = (rec, pat) => { for (let i = 0; i + pat.length <= rec.length; i++) if (pat.every((v, j) => rec[i + j] === v)) return true; return false; };
/** 送った READ SCREEN の応答（GDS ヘッダの後ろ 1920 桁の画面を含む長いレコード）のうち、OLD か NEW を含むもの */
const screenReplies = (recs) => recs.filter((r) => r.length > 1900);
let pass = 0, fail = 0;
const check = (c, m) => { if (c) { pass++; log(`  PASS ${m}`); } else { fail++; log(`  FAIL ${m}`); } };

for (const [pgm, want] of [["READSCRTIMING", "OLD"], ["READSCRTIMING2", "NEW"]]) {
  const cmd = inputs().find((f) => f.length > 20);
  if (!cmd) { log("コマンド欄が見つからない"); break; }
  session.setField({ index: cmd.index }, `CALL ${LIB}/DSCMD PARM('${pgm}')`);
  const at = outbound.length + 1; // CALL の Enter の後ろ
  await session.sendAid("Enter", { timeoutMs: 25000 }).catch(() => {});
  await sleep(4000);
  const replies = screenReplies(outbound.slice(at));
  const got = replies.map((r) => (has(r, OLD) ? "OLD" : has(r, NEW) ? "NEW" : "none"));
  check(got.length === 1 && got[0] === want, `${pgm}: 応答の画面は ${JSON.stringify(got)}（ACS: ${want}）`);
  // DSM の 2 回目の読み（READ INPUT）を Enter で抜ける
  await session.sendAid("Enter", { timeoutMs: 15000 }).catch(() => {});
  await sleep(2500);
}
const cmd = inputs().find((f) => f.length > 20);
if (cmd) { session.setField({ index: cmd.index }, "SIGNOFF"); await session.sendAid("Enter", { timeoutMs: 10000 }).catch(() => {}); }
session.disconnect();
log(`RESULT: pass=${pass} fail=${fail}`);
process.exit(fail > 0 ? 1 : 0);
