// 実機検証（tn5250）: **WTD の中のオーダーの誤りに ACS と同じ否定応答を返し、同じ WTD の CC2 は効かせるか**（`20260927-wtd-order-sense`）。
//
// 前提: `DSCMD_LIB=<AS400_LIB> node --env-file=.env --env-file=.env.verify scripts/build-dscmd.mjs`
// （`scripts/host-src/dscmd.c` の WTDERR*。先にメッセージ待ちを消し、1 本の WTD〔CC2＝0x01・5 行に WTDERR〕の後ろに誤ったオーダー → 8 秒待つ → メッセージ待ちを消す）。
// ACS は WTD の中の誤りでは否定応答を返すがレコードの終わり（CC2）は走らせる——メッセージ待ちは**点く**（ACS のコアの実測）。ACS のコアの結果は `scripts/acs-probe/wtd-order-sense.txt`。
// **終わったら DLTPGM <AS400_LIB>/DSCMD と IFS の /tmp/dscmd.c・/tmp/dscmd.log を消す**。
//
// 実行: node --env-file=.env --env-file=.env.verify scripts/verify-wtd-order-sense.mjs [モード…]
import { Session5250 } from "@ts5250/tn5250";

const LIB = (process.env.AS400_LIB ?? "TESTLIB").trim().split(/\s+/)[0];
/** モードと、ACS が返したセンス（ワイヤで確かめた値。research F2） */
const SENSE_OF = {
  WTDERRSBA: "10050122", WTDERRRA: "10050123", WTDERRSOH: "1005012b", WTDERREA: "1005012d", WTDERRSHORT: "10050121",
  // WEA（`20260927-wea-sense`。`acs-probe/wea-sense.txt`）: タイプ 1・タイプ 5 の不正な値・EA で最後の桁まで消した後・SBCS のセッションのタイプ 5
  WTDERRWEA1: "1005012d", WTDERRWEA5X: "1005012f", WTDERRWEAEND: "1005012a", WTDERRWEA5: "1005012d",
  // 受理の残り（`20260927-wtd-sense-rest`。ACS のコアの画面とワイヤ〔tap〕）: SBA 1,0・FFW 0xC000 は受ける（否定応答なし）、
  // 画面の末尾を越える TD・文字は 0x10050121 で打ち切る（CC2 も効かない）、欄を入れられない SF は 0x10050125
  WTDERRSBA10: null, WTDERRFFWC0: null, WTDERRTDEND: "10050121", WTDERRCHEND: "10050121",
  WTDERRFLEN0: "10050125", WTDERRFLDEND: "10050125", WTDERRJODD: "10050125", WTDERRCONTMID: "10050125",
  // WDSF の頭の検査（`20260927-wdsf-sense`。ACS のコアを ENPTUI 有効〔当 PJ は常に申告〕で当てたワイヤ）: LL が 3 → 0x10050110、クラス 0xD8・知らない型 → 0x10050111
  WTDERRWDSFLL: "10050110", WTDERRWDSFCLS: "10050111", WTDERRWDSFTYPE: "10050111"
};
/** CC2 まで落とす（レコードを打ち切る）モード——ACS のコアは mw=false・NEXT を書かなかった */
const ABORT_MODES = new Set(["WTDERRTDEND", "WTDERRCHEND"]);
/** 後ろの 6 行の NEXT を書かないモード（WTD の打ち切り） */
const NO_NEXT = (m) => m.startsWith("WTDERRWEA") || ABORT_MODES.has(m) || /^WTDERR(FLEN0|FLDEND|JODD|CONTMID|WDSFLL|WDSFCLS|WDSFTYPE)$/.test(m);
/** SBCS のセッションで流すモード（社内機は SBCS の装置を自動構成しないので PUB400 の 37 で。`PUB400_*` と `PUB400_LIB` を使う） */
const SBCS_MODES = new Set(["WTDERRWEA5"]);
const MODES = process.argv.slice(2).length ? process.argv.slice(2) : Object.keys(SENSE_OF);
for (const m of MODES) if (SENSE_OF[m] === undefined) { process.stderr.write(`知らないモード: ${m}（${Object.keys(SENSE_OF).join(" / ")}）\n`); process.exit(2); }
const log = (s) => process.stderr.write(`${s}\n`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const inputs = (s) => s.snapshot().fields.filter((f) => !f.protected);
const warns = [];
let pass = 0, fail = 0;
const check = (c, m) => { if (c) { pass++; log(`  PASS ${m}`); } else { fail++; log(`  FAIL ${m}`); } };

// **モードごとに繋ぎ直す**——続けて流すと、否定応答の後の 2 本目の CALL が効かない（ACS のコアでも同じだった。ホスト側の都合）
for (const mode of MODES) {
  const sense = SENSE_OF[mode];
  log(`### ${mode}`);
  const sbcs = SBCS_MODES.has(mode);
  const P = sbcs ? "PUB400" : "AS400";
  const s = await Session5250.connect({ host: sbcs ? process.env.PUB400_HOST ?? "pub400.com" : process.env.AS400_HOST, ccsid: sbcs ? 37 : 930, warn: (w) => warns.push(w) });
  // 返したレコードを控える（否定応答のセンスを照合する）
  const sent = [];
  const origSend = s.telnet.sendRecord.bind(s.telnet); // private だが測定のためだけ
  s.telnet.sendRecord = (rec) => { sent.push(Array.from(rec, (b) => b.toString(16).padStart(2, "0")).join("")); origSend(rec); };
  await sleep(1000);
  const [u, p] = inputs(s);
  s.setField({ index: u.index }, process.env[`${P}_USER`]);
  s.setField({ index: p.index }, process.env[`${P}_PASSWORD`]);
  await s.sendAid("Enter", { cursor: { row: u.row, col: u.col }, timeoutMs: 15000 });
  for (let i = 0; i < 4; i++) { await sleep(800); if (inputs(s).some((f) => f.length >= 50)) break; await s.sendAid("Enter", { timeoutMs: 10000 }).catch(() => {}); }
  const cmd = inputs(s).find((f) => f.length >= 50);
  if (!cmd) { check(false, `${mode}: コマンド行が出ない（サインオンに失敗）`); s.disconnect(); continue; }
  const lib = sbcs ? (process.env.PUB400_LIB ?? "TESTLIB").trim().split(/\s+/)[0] : LIB;
  s.setField({ index: cmd.index }, `CALL ${lib}/DSCMD PARM('${mode}')`);
  const nW = warns.length, nS = sent.length;
  void s.sendAid("Enter", { cursor: { row: cmd.row, col: cmd.col }, timeoutMs: 20000 }).catch(() => {});
  await sleep(6000);
  const snap = s.snapshot();
  const row5 = snap.cells[4].map((c) => c.char).join("").trim();
  // センスは GDS のヘッダーの中（バイト境界）——偶数桁でだけ照合する（奇数桁の一致は偶然）
  const anyNegative = sent.slice(nS).some((h) => /^(?:..)*?100501/.test(h));
  const negative = sense === null ? !anyNegative : sent.slice(nS).some((h) => new RegExp(`^(?:..)*?${sense}`).test(h));
  const row6 = snap.cells[5].map((c) => c.char).join("").trim();
  log(`  窓の中: mw=${snap.messageWaiting === true} row5=${JSON.stringify(row5)} row6=${JSON.stringify(row6)} 否定応答 ${sense ?? "なし"}=${negative}`);
  log(`  警告: ${JSON.stringify(warns.slice(nW))}`);
  check(row5.startsWith("WTDERR"), `${mode}: 誤りの前の文字は画面に書かれた`);
  check(negative, sense === null ? `${mode}: 否定応答を返さない（受ける）` : `${mode}: 否定応答 0x${sense} を返した`);
  if (ABORT_MODES.has(mode)) check(snap.messageWaiting !== true, `${mode}: レコードを打ち切るので CC2 は効かない（ACS と同じ）`);
  else check(snap.messageWaiting === true, `${mode}: メッセージ待ちは点く（WTD の中の誤りでも CC2 は効く）`);
  if (NO_NEXT(mode)) check(!row6.includes("NEXT"), `${mode}: 後ろ（6 行の NEXT）は書かれない（WTD の打ち切り。ACS と同じ）`);
  else if (sense === null) check(row6.includes("NEXT"), `${mode}: 後ろ（6 行の NEXT）も書く`);
  if (mode === "WTDERRSBA10") {
    const row1 = snap.cells[0].map((c) => c.char).join("").trim();
    check(row1 === "AB" && snap.fields.some((f) => f.row === 1 && f.col === 1), `${mode}: AB は 1 行 1 桁の入力欄に入る（ACS と同じ）`);
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
