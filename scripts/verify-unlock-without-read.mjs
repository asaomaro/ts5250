// **アンロックだけで READ の無い区間**の当 PJ（コア）の振る舞いを実機で測る（ACS との突き合わせ）。
//
// `scripts/build-ulktest.mjs` の ULKPGM（UNLOCK。DFRWRT(*NO)）: SNDF（出力だけ・LOCK 無し）→ 10 秒 → SNDRCVF。
// ACS（`scripts/acs-probe/unlock-without-read.txt`）は区間中 inhibit=0 を示すが、**打った文字は画面に入れず溜め**、
// READ が来てから再生した（Enter も READ の後に送った）。当 PJ は区間中どう見えて、AID の応答待ちはいつ解けるか。
//
// 実行: node --env-file=.env --env-file=.env.verify scripts/verify-unlock-without-read.mjs
import { Session5250 } from "@ts5250/tn5250";

const host = process.env.AS400_HOST, user = process.env.AS400_USER, password = process.env.AS400_PASSWORD;
const LIB = process.env.AS400_LIB ?? "TESTLIB";
if (!host || !user || !password) { process.stderr.write("AS400_HOST / AS400_USER / AS400_PASSWORD が要ります（.env）\n"); process.exit(2); }
const ccsid = Number(process.env.AS400_CCSID ?? 930);
const log = (s) => process.stderr.write(`${s}\n`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rows = (snap) => snap.cells.map((r) => r.map((c) => c.char).join("").replace(/\s+$/, ""));
const inputsOf = (snap) => snap.fields.filter((f) => !f.protected);

const s = await Session5250.connect({ host, ccsid, warn: () => {} });
await sleep(800);
let inputs = inputsOf(s.snapshot());
s.setField({ index: inputs[0].index }, user);
s.setField({ index: inputs[1].index }, password);
await s.sendAid("Enter", { cursor: { row: inputs[0].row, col: inputs[0].col }, timeoutMs: 15000 });
for (let i = 0; i < 6; i++) {
  await sleep(800);
  const t = rows(s.snapshot());
  if (t.some((r) => /===>/.test(r))) break;
  if (t.some((r) => r.includes("対話式ジョブの回復"))) {
    const f = inputsOf(s.snapshot()).slice(-1)[0];
    s.setField({ index: f.index }, "90");
    await s.sendAid("Enter", { cursor: { row: f.row, col: f.col }, timeoutMs: 12000 });
  } else await s.sendAid("Enter", { timeoutMs: 10000 });
}
const cmd = inputsOf(s.snapshot()).find((f) => f.length >= 50);
s.setField({ index: cmd.index }, `CALL ${LIB}/ULKPGM PARM('UNLOCK')`);
const t0 = Date.now();
const p = s.sendAid("Enter", { cursor: { row: cmd.row, col: cmd.col }, timeoutMs: "never" }).then(() => Date.now() - t0);
await sleep(2500);
const w = s.snapshot();
log(`window(2.5s): state=${s.currentState} keyboardLocked=${w.keyboardLocked} row1="${rows(w)[0].trim()}"`);
const waited = await p;
const r = s.snapshot();
log(`AID resolved after ${(waited / 1000).toFixed(1)}s: state=${s.currentState} keyboardLocked=${r.keyboardLocked} row1="${rows(r)[0].trim()}"`);
await s.sendAid("F3", { timeoutMs: 10000 }).catch(() => {});
await sleep(800);
const c2 = inputsOf(s.snapshot()).find((f) => f.length >= 50);
if (c2) { s.setField({ index: c2.index }, "SIGNOFF"); await s.sendAid("Enter", { timeoutMs: 10000 }).catch(() => {}); }
s.disconnect();
