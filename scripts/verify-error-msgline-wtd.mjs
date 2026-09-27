// 実機検証（tn5250）: **エラー状態のままメッセージ行へ WTD・RESTORE SCREEN が来たとき、当 PJ はどう見せるか**（`20260927-error-msgline-wtd`）。
//
// 前提: `DSCMD_LIB=<AS400_LIB> node --env-file=.env --env-file=.env.verify scripts/build-dscmd.mjs`
// （`scripts/host-src/dscmd.c` の ERRMSGWTD / ERRMSGRST。24 行に MSGLINE ORIGINAL… → 0x21 でエラー状態 → WTD で 24 行に NEW LINE24 / 退避した画面を RESTORE → READ MDT）。
// ACS のコアの結果は `scripts/acs-probe/error-msgline-wtd.txt`（エラーのメッセージを出している間は **WTD を保留**し〔`DS5250.checkContention`〕、Reset の後に処理する。
// RESTORE は保留しないが、Reset の戻し〔0x21 の時点のメッセージ行〕が RESTORE の 24 行を上書きする）。
// Reset の代わりに `dismissHostError`（画面の側が抜けたときに呼ぶもの。`20260927-host-error-hold`）を呼び、ACS の Reset の後と同じになるかを見る。**終わったら DLTPGM と IFS の /tmp/dscmd.* を消す**。
//
// 実行: node --env-file=.env --env-file=.env.verify scripts/verify-error-msgline-wtd.mjs [ERRMSGWTD|ERRMSGRST]
import { Session5250 } from "@ts5250/tn5250";

const LIB = (process.env.AS400_LIB ?? "TESTLIB").trim().split(/\s+/)[0];
const MODES = process.argv.slice(2).length ? process.argv.slice(2) : ["ERRMSGWTD", "ERRMSGRST"];
const log = (s) => process.stderr.write(`${s}\n`);
let pass = 0, fail = 0;
const check = (c, m) => { if (c) { pass++; log(`  PASS ${m}`); } else { fail++; log(`  FAIL ${m}`); } };
/** ACS のコアの 24 行目（Reset の後）。`20260927-error-msgline-wtd` research F1 */
const ACS_AFTER = { ERRMSGWTD: "NEW LINE24IGINAL TEXT TO BE RESTORED", ERRMSGRST: "CHANGED ORIGINAL TEXT TO BE RESTORED" };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const inputs = (s) => s.snapshot().fields.filter((f) => !f.protected);
for (const mode of MODES) {
  log(`### ${mode}`);
  const s = await Session5250.connect({ host: process.env.AS400_HOST, ccsid: 930, warn: () => {} });
  await sleep(1000);
  const [u, p] = inputs(s);
  s.setField({ index: u.index }, process.env.AS400_USER);
  s.setField({ index: p.index }, process.env.AS400_PASSWORD);
  await s.sendAid("Enter", { cursor: { row: u.row, col: u.col }, timeoutMs: 15000 });
  for (let i = 0; i < 4; i++) { await sleep(800); if (inputs(s).some((f) => f.length >= 50)) break; await s.sendAid("Enter", { timeoutMs: 10000 }).catch(() => {}); }
  const cmd = inputs(s).find((f) => f.length >= 50);
  s.setField({ index: cmd.index }, `CALL ${LIB}/DSCMD PARM('${mode}')`);
  void s.sendAid("Enter", { cursor: { row: cmd.row, col: cmd.col }, timeoutMs: 20000 }).catch(() => {});
  await sleep(7000);
  const snap = s.snapshot();
  const row24 = snap.cells[23].map((c) => c.char).join("").trim();
  log(`  エラーの後: systemMessage=${JSON.stringify(snap.systemMessage)} 24 行目のセル=${JSON.stringify(row24)} 5 行目=${JSON.stringify(snap.cells[4].map((c) => c.char).join("").trim())}`);
  check(snap.systemMessage === "ERROR ON MSGLINE", `${mode}: エラーのメッセージを出したまま（ACS と同じ）`);
  s.dismissHostError(snap.systemMessageSeq);
  await sleep(1500);
  const after = s.snapshot().cells[23].map((c) => c.char).join("").trim();
  log(`  抜けた後: systemMessage=${JSON.stringify(s.snapshot().systemMessage)} 24 行目=${JSON.stringify(after)}`);
  check(after === ACS_AFTER[mode], `${mode}: 抜けた後の 24 行目が ACS の Reset の後と同じ（${JSON.stringify(ACS_AFTER[mode])}）`);
  await s.sendAid("Enter", { timeoutMs: 10000 }).catch(() => {});
  await sleep(2000);
  const c2 = inputs(s).find((f) => f.length >= 50);
  if (c2) { s.setField({ index: c2.index }, "SIGNOFF"); await s.sendAid("Enter", { cursor: { row: c2.row, col: c2.col }, timeoutMs: 10000 }).catch(() => {}); }
  await sleep(500);
  s.disconnect();
  await sleep(1500);
}
log(`RESULT: pass=${pass} fail=${fail}`);
process.exit(fail > 0 ? 1 : 0);
