// 実機検証（tn5250）: **EA（0x03）の後の書き始め・属性タイプ・長さ 3 以上が ACS と同じか**（`20260927-ea-acs`）。
//
// 前提: `DSCMD_LIB=<AS400_LIB> node --env-file=.env --env-file=.env.verify scripts/build-dscmd.mjs`
// （`scripts/host-src/dscmd.c` の EATEST*。1 本の WTD〔CC2＝メッセージ待ち〕: 6 行 2 桁に ABCDEFGHIJ → SBA 6,4 → EA〔行き先 6,6〕→ X → 6,20 に END。
//  EATESTEND / EATESTOVER / EATESTWRAP は 6 行目の後に 24 行目へ「EA 24,80 の後ろの X」「24,79 から XYZ」「24,78 から XYZ → IC → W」を置く）。
// ACS のコアの結果（`scripts/acs-probe/ea-acs.txt`・ワイヤは `tap-proxy.mjs`）を期待値に置く。**モードごとに繋ぎ直す**（否定応答の後の CALL は効かない）。
// **終わったら DLTPGM <AS400_LIB>/DSCMD と IFS の /tmp/dscmd.c・/tmp/dscmd.log を消す**。
//
// 実行: node --env-file=.env --env-file=.env.verify scripts/verify-ea-acs.mjs [モード…]
import { Session5250 } from "@ts5250/tn5250";

const LIB = (process.env.AS400_LIB ?? "TESTLIB").trim().split(/\s+/)[0];
/** ACS のコアの 6 行目（桁 1 から。右の空白は落とす）と、返したセンス（無ければ undefined） */
const ACS = {
  EATESTFF: { row6: " AB   XGHIJ        END", sense: undefined },
  EATEST00: { row6: " AB   XGHIJ        END", sense: undefined },
  EATEST01: { row6: " ABCDEFGHIJ", sense: "1005012d" },
  EATEST3: { row6: " AB   FGHIJ", sense: "10050123" },
  // 画面の終わりを越える並び: 並びを書かず 0x10050121・CC2 も落とす（メッセージ待ちは点かない。6 行目の WTD の頭の文字は書かれる）
  EATESTEND: { row6: " ABCDEFGHIJ", row24: "01234", sense: "10050121", mw: false },
  EATESTOVER: { row6: " ABCDEFGHIJ", row24: "", sense: "10050121", mw: false },
  // 最後の桁でちょうど終わった並びの次は 1 行 1 桁から（ACS は位置を画面の大きさで割った余りに戻す）
  EATESTWRAP: { row6: " ABCDEFGHIJ        END", row24: "XYZ", row1: "WX", sense: undefined }
};
const MODES = process.argv.slice(2).length ? process.argv.slice(2) : Object.keys(ACS);
for (const m of MODES) if (!ACS[m]) { process.stderr.write(`知らないモード: ${m}（${Object.keys(ACS).join(" / ")}）\n`); process.exit(2); }
const log = (s) => process.stderr.write(`${s}\n`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const inputs = (s) => s.snapshot().fields.filter((f) => !f.protected);
let pass = 0, fail = 0;
const check = (c, m) => { if (c) { pass++; log(`  PASS ${m}`); } else { fail++; log(`  FAIL ${m}`); } };

for (const mode of MODES) {
  log(`### ${mode}`);
  const s = await Session5250.connect({ host: process.env.AS400_HOST, ccsid: 930, warn: () => {} });
  const sent = [];
  const origSend = s.telnet.sendRecord.bind(s.telnet); // private だが測定のためだけ
  s.telnet.sendRecord = (rec) => { sent.push(Array.from(rec, (b) => b.toString(16).padStart(2, "0")).join("")); origSend(rec); };
  await sleep(1000);
  const [u, p] = inputs(s);
  s.setField({ index: u.index }, process.env.AS400_USER);
  s.setField({ index: p.index }, process.env.AS400_PASSWORD);
  await s.sendAid("Enter", { cursor: { row: u.row, col: u.col }, timeoutMs: 15000 });
  for (let i = 0; i < 4; i++) { await sleep(800); if (inputs(s).some((f) => f.length >= 50)) break; await s.sendAid("Enter", { timeoutMs: 10000 }).catch(() => {}); }
  const cmd = inputs(s).find((f) => f.length >= 50);
  if (!cmd) { check(false, `${mode}: コマンド行が出ない（サインオンに失敗）`); s.disconnect(); continue; }
  s.setField({ index: cmd.index }, `CALL ${LIB}/DSCMD PARM('${mode}')`);
  const nS = sent.length;
  void s.sendAid("Enter", { cursor: { row: cmd.row, col: cmd.col }, timeoutMs: 20000 }).catch(() => {});
  await sleep(6000);
  const snap = s.snapshot();
  const row6 = snap.cells[5].map((c) => c.char).join("").replace(/\s+$/, "");
  // センスは GDS のヘッダーの中（バイト境界）——偶数桁でだけ照合する
  // 否定応答は広く拾う（0x10xxxxxx のどの族でも）——期待が「なし」のモードで別の族の否定応答を見逃さない
  const senses = sent.slice(nS).map((h) => /^(?:..)*?04800000(10[0-9a-f]{6})/.exec(h)?.[1]).filter(Boolean);
  log(`  6 行目=${JSON.stringify(row6)} mw=${snap.messageWaiting === true} センス=${JSON.stringify(senses)}`);
  check(row6 === ACS[mode].row6, `${mode}: 6 行目が ACS と同じ（${JSON.stringify(ACS[mode].row6)}）`);
  check(ACS[mode].sense === undefined ? senses.length === 0 : senses.includes(ACS[mode].sense), `${mode}: 否定応答が ACS と同じ（${ACS[mode].sense ?? "なし"}）`);
  const mw = ACS[mode].mw ?? true;
  check((snap.messageWaiting === true) === mw, `${mode}: メッセージ待ちは${mw ? "点く" : "点かない"}（ACS と同じ）`);
  if (ACS[mode].row1 !== undefined) {
    const row1 = snap.cells[0].map((c) => c.char).join("").trim();
    check(row1 === ACS[mode].row1, `${mode}: 1 行目が ACS と同じ（${JSON.stringify(ACS[mode].row1)}）`);
  }
  if (ACS[mode].row24 !== undefined) {
    const row24 = snap.cells[23].map((c) => c.char).join("").trim();
    check(row24 === ACS[mode].row24, `${mode}: 24 行目が ACS と同じ（${JSON.stringify(ACS[mode].row24)}）`);
  }
  await sleep(9000);
  const c2 = inputs(s).find((f) => f.length >= 50);
  if (c2) { s.setField({ index: c2.index }, "SIGNOFF"); await s.sendAid("Enter", { cursor: { row: c2.row, col: c2.col }, timeoutMs: 10000 }).catch(() => {}); }
  await sleep(500);
  s.disconnect();
  await sleep(1500);
}
log(`RESULT: pass=${pass} fail=${fail}`);
process.exit(fail > 0 ? 1 : 0);
