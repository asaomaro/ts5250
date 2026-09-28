// 実機検証: **WDSF の構造体ごとの長さ・引数の否定応答**（`20260928-wdsf-negative`）。
//
// 当 PJ のコア（dist）を実機へ繋ぎ、DSM の WDSFNEG の 15 巡を出させて、ホストの読みの結果（/tmp/dscmd.log の `[N01]`〜`[N15]` の QsnReadMDT）を ACS のコア
// （`scripts/acs-probe/wdsf-negative.txt`）と比べる。ACS: N01〜N14 は CPFA304（否定応答）、N15（正しい 0x5F）は Enter を待って rc=0。
//
// 前提: npm run build ／ DSCMD_LIB=<AS400_LIB> node --env-file=.env --env-file=.env.verify scripts/build-dscmd.mjs
// 実行: node --env-file=.env --env-file=.env.verify scripts/verify-wdsf-negative.mjs
// **終わったら DLTPGM と IFS の /tmp/dscmd.c・/tmp/dscmd.log を消す**。
import { Session5250 } from "@ts5250/tn5250";
import { IfsConnection } from "@ts5250/hostserver";
import { codecForCcsid } from "@ts5250/ebcdic";

const host = process.env.AS400_HOST;
const user = process.env.AS400_USER;
const password = process.env.AS400_PASSWORD;
if (!host || !user || !password) { process.stderr.write("AS400_* が要ります\n"); process.exit(2); }
const LIB = (process.env.AS400_LIB ?? "TESTLIB").trim().split(/\s+/)[0];
const log = (s) => process.stderr.write(s + "\n");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
const check = (c, m) => { if (c) { pass++; log(`  PASS ${m}`); } else { fail++; log(`  FAIL ${m}`); } };

const session = await Session5250.connect({ host, port: 23, ccsid: 5035, screenSize: "24x80", enhanced: true, warn: () => {} });
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
const cmd = inputs().find((f) => f.length > 20);
session.setField({ index: cmd.index }, `CALL ${LIB}/DSCMD PARM('WDSFNEG')`);
await session.sendAid("Enter", { timeoutMs: 25000 }).catch(() => {});
await sleep(4000);
for (let i = 0; i < 3; i++) {
  await session.sendAid("Enter", { cursor: { row: 20, col: 10 }, timeoutMs: 15000 }).catch(() => {});
  await sleep(2500);
}
const c2 = inputs().find((f) => f.length > 20);
if (c2) { session.setField({ index: c2.index }, "SIGNOFF"); await session.sendAid("Enter", { timeoutMs: 10000 }).catch(() => {}); }
session.disconnect();

const ifs = await IfsConnection.connect({ host, user, password });
const t = await ifs.readTextFile("/tmp/dscmd.log");
const bytes = t?.data ?? t;
const hostLog = typeof bytes === "string" ? bytes : codecForCcsid(t?.ccsid ?? 37).decode(Uint8Array.from(Object.values(bytes)));
ifs.close?.();
for (let k = 1; k <= 15; k++) {
  const tag = `N${String(k).padStart(2, "0")}`;
  const line = hostLog.split("\n").find((l) => l.startsWith(`[${tag}] QsnReadMDT`)) ?? "";
  const negative = /CPFA304/.test(line);
  check(k <= 14 ? negative : /rc=0/.test(line), `${tag}: ${line.replace(/^\[N\d+\] /, "")}（ACS: ${k <= 14 ? "CPFA304" : "rc=0"}）`);
}
log(`RESULT: pass=${pass} fail=${fail}`);
process.exit(fail > 0 ? 1 : 0);
