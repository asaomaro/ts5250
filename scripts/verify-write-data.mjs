// 実機検証: **WDSF 0x54（欄へのデータの書き込み。EBCDIC の形）**（`20260928-wdsf-write-data`）。
//
// 当 PJ のコア（dist）を実機へ繋ぎ、DSM の WRITEDATA の 4 巡を ACS のコア（`scripts/acs-probe/write-data.txt`）の結果と比べる:
// D1 `OLDVALUE12` の欄に `NEW`＋続けて `Z` → `NEWZ`・READ MDT で欄を送らない（MDT は立たない）／D2 欄の先頭でない・D3 欄より長い → ホストの読みが CPFA304（否定応答）／
// D4 3 区間の継続欄に `ABCDEFGHIJ` → `ABCD`/`EFGH`/`IJ`。
//
// 前提: npm run build ／ DSCMD_LIB=<AS400_LIB> node --env-file=.env --env-file=.env.verify scripts/build-dscmd.mjs
// 実行: node --env-file=.env --env-file=.env.verify scripts/verify-write-data.mjs
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

const session = await Session5250.connect({ host, port: 23, ccsid: 5035, screenSize: "24x80", warn: () => {} });
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
session.setField({ index: cmd.index }, `CALL ${LIB}/DSCMD PARM('WRITEDATA')`);
await session.sendAid("Enter", { timeoutMs: 25000 }).catch(() => {});
await sleep(3000);
const row = (r, c, n) => session.snapshot().cells[r - 1].slice(c - 1, c - 1 + n).map((x) => x.char || " ").join("");
check(row(5, 10, 10) === "NEWZ      ", `D1 (5,10) ${JSON.stringify(row(5, 10, 10))}（ACS: "NEWZ"）`);
await session.sendAid("Enter", { cursor: { row: 20, col: 10 }, timeoutMs: 20000 }).catch(() => {});
await sleep(3500); // D2・D3 は否定応答でホストの読みがすぐ戻り、D4 の画面になる
const d4 = [row(7, 10, 4), row(8, 10, 4), row(9, 10, 4)];
check(JSON.stringify(d4) === JSON.stringify(["ABCD", "EFGH", "IJ  "]), `D4 継続欄 ${JSON.stringify(d4)}（ACS: ABCD/EFGH/IJ）`);
await session.sendAid("Enter", { cursor: { row: 20, col: 10 }, timeoutMs: 20000 }).catch(() => {});
await sleep(2500);
const c2 = inputs().find((f) => f.length > 20);
if (c2) { session.setField({ index: c2.index }, "SIGNOFF"); await session.sendAid("Enter", { timeoutMs: 10000 }).catch(() => {}); }
session.disconnect();

const ifs = await IfsConnection.connect({ host, user, password });
const t = await ifs.readTextFile("/tmp/dscmd.log");
const bytes = t?.data ?? t;
const hostLog = typeof bytes === "string" ? bytes : codecForCcsid(t?.ccsid ?? 37).decode(Uint8Array.from(Object.values(bytes)));
ifs.close?.();
check(/\[D1\] QsnRtvFldDta len=0/.test(hostLog), "D1 の READ MDT は欄を送らない（ACS と同じ——MDT が立たない）");
check(/\[D2\] QsnReadMDT rc=-1 .*CPFA304/.test(hostLog), "D2（欄の先頭でない）はホストの読みが CPFA304（否定応答）");
check(/\[D3\] QsnReadMDT rc=-1 .*CPFA304/.test(hostLog), "D3（欄より長い）はホストの読みが CPFA304（否定応答）");
log(`RESULT: pass=${pass} fail=${fail}`);
process.exit(fail > 0 ? 1 : 0);
