// 実機検証（tn5250）: **帳票の応答を止めている間に、ホストが帳票を取り消したら何が起きるか**（`20260927-printer-hold-cancel`）。
// `20260921-printer-hold-response` の残り。PUB400 は書き出しプログラムを止める権限が無い（CPF3330 系）ので、社内機で測る。
//
// 手順（取り消し方ごとに 1 回ずつ。どちらも「プリンターの応答を止めたまま」で行う）:
//   1) プリンターを開き（応答を止める `respondAfter`）、書き出しプログラムを起こし、自分のジョブのスプールを 1 件流す
//   2) 帳票が届いて止まったら、ホストで取り消す——HLDSPLF *IMMED / ENDWTR *IMMED
//   3) 取り消しの後に届いたレコード（CLEAR か・終了のレコードか）・スプールの状態・接続が切れたかを記録する
//   4) 応答を解く → 何を返したか（CLEAR_PROCESSED か）・スプールの状態
// **片付け**: 自分が流したスプールを DLTSPLF で消し、書き出しプログラムを止める。**装置は作らない・消さない。**
//
// **HOLD_IDLE_MIN=<分>** を付けると、取り消さずに応答を止めたまま <分> 待ち、接続が黙って切れないか・スプールの状態を見る
// （同じ残り項目の「止めている間に 15 分のアイドルで接続が死ぬか」。`measure-printer-idle-drop`）。
//
// 実行: node --env-file=.env --env-file=.env.verify scripts/verify-printer-hold-cancel.mjs
//   AS400_HOST / AS400_USER / AS400_PASSWORD（`.env`）、AS400_PRTDEV（`.env.verify`）
import { PrinterSession } from "@ts5250/tn5250";
import { CommandConnection, DbConnection, query } from "@ts5250/hostserver";

const host = process.env.AS400_HOST;
const user = process.env.AS400_USER;
const password = process.env.AS400_PASSWORD;
const PRTDEV = (process.env.AS400_PRTDEV ?? "PRT_TEST").trim();
if (!host || !user || !password) {
  process.stderr.write("AS400_HOST / AS400_USER / AS400_PASSWORD が要ります（.env）\n");
  process.exit(2);
}
/** 装置名・利用者名は環境の固有名詞なので伏せて出す（出力を research に貼るため） */
const mask = (t) => String(t).replaceAll(PRTDEV, "<PRTDEV>").replaceAll(user.toUpperCase(), "<USER>");
const log = (s) => process.stderr.write(`${mask(s)}\n`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const hex = (b) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join(" ");

const cc = await CommandConnection.connect({ host, user, password });
const db = await DbConnection.connect({ host, user, password });
const run = async (c) => {
  const r = await cc.run(c).catch((e) => ({ success: false, messages: [{ id: String(e).slice(0, 60) }] }));
  log(`  > ${c} → ${r.success ? "ok" : "NG"} ${(r.messages ?? []).map((m) => m.id).join(",")}`);
  return r;
};
/**
 * 待ち行列の自分のスプール（QPRTLIBL）のうち、**この実行で作ったもの**（開始前にあったものは `preexisting` で除く——触らない・消さない）。
 * スプールはコマンドの実行ジョブではなく利用者のスプール用のジョブ（QPRTJOB）に付くので、JOB(*) では指せない
 */
const preexisting = new Set();
async function queued() {
  const r = await query(db, `SELECT STATUS, FILE_NUMBER, JOB_NAME FROM QSYS2.OUTPUT_QUEUE_ENTRIES_BASIC WHERE OUTPUT_QUEUE_NAME = '${PRTDEV}' AND SPOOLED_FILE_NAME = 'QPRTLIBL' AND USER_NAME = '${user.toUpperCase()}' ORDER BY FILE_NUMBER`);
  return r.rows;
}
async function mine() {
  return (await queued()).filter((x) => !preexisting.has(`${x.JOB_NAME}#${x.FILE_NUMBER}`));
}
async function spools() {
  return (await mine()).map((x) => `${x.STATUS}#${x.FILE_NUMBER}`).join(" ") || "(無し)";
}
/** 書き出しプログラムのジョブの状態（MSGW＝用紙の問い合わせ等で止まっている） */
async function writer() {
  const r = await query(db, `SELECT JOB_STATUS FROM TABLE(QSYS2.ACTIVE_JOB_INFO(JOB_NAME_FILTER => '${PRTDEV}')) X`);
  return r.rows.map((x) => x.JOB_STATUS).join(",") || "(無し)";
}
/**
 * 書き出しプログラムの位置合わせの問い合わせ（CPA4044。QSYSOPR）に I（続行）で答える。最初のファイルで必ず出て MSGW で止まる（3 回目の実測）。
 * 答えるのは**この実行で起こした書き出しプログラムから、この実行の後に出たもの**だけ
 */
const answered = new Set();
async function answerAlign(since) {
  const r = await query(db, `SELECT HEX(MESSAGE_KEY) K FROM QSYS2.MESSAGE_QUEUE_INFO WHERE MESSAGE_QUEUE_LIBRARY = 'QSYS' AND MESSAGE_QUEUE_NAME = 'QSYSOPR' AND MESSAGE_ID = 'CPA4044' AND FROM_JOB LIKE '%/QSPLJOB/${PRTDEV}' AND MESSAGE_TIMESTAMP >= '${since}'`);
  // RMV(*NO) なので答えたものも残る——答えた鍵を控えて二度答えない
  const fresh = r.rows.filter((x) => !answered.has(x.K));
  for (const x of fresh) { answered.add(x.K); await run(`SNDRPY MSGKEY(X'${x.K}') MSGQ(QSYS/QSYSOPR) RPY(I) RMV(*NO)`); }
  return fresh.length;
}
const nowTs = async () => String((await query(db, "SELECT CHAR(CURRENT TIMESTAMP) T FROM SYSIBM.SYSDUMMY1")).rows[0].T).trim();
for (const x of await queued()) preexisting.add(`${x.JOB_NAME}#${x.FILE_NUMBER}`);
// 前の実行の書き出しプログラムが古い接続を掴んでいると、スプールは WRITER のまま届かない（1 回目の実測）。先に止める。
// **実行前の書き出しプログラムの状態には戻さない**（最後は止めたまま。ホストは次にプリンターが繋いだとき自動で起こす）
await cc.run(`ENDWTR WTR(${PRTDEV}) OPTION(*IMMED)`).catch(() => {});
await sleep(3000);

const IDLE_MIN = Number(process.env.HOLD_IDLE_MIN ?? 0);
const CASES = IDLE_MIN > 0
  ? [[`止めたまま ${IDLE_MIN} 分`, undefined]]
  : [
      ["HLDSPLF *IMMED", (sp) => `HLDSPLF FILE(QPRTLIBL) JOB(${sp.JOB_NAME}) SPLNBR(${sp.FILE_NUMBER}) OPTION(*IMMED)`],
      ["ENDWTR *IMMED", () => `ENDWTR WTR(${PRTDEV}) OPTION(*IMMED)`]
    ];
// **途中で落ちても片付ける**（止めた応答のままの接続・起こし直した書き出しプログラム・スプールを残さない）
let prt;
try {
for (const [label, cancel] of CASES) {
  log(`\n### ${label}`);
  let releaseGate;
  let held = 0;
  const seen = [];
  const sent = [];
  prt = await PrinterSession.connect({
    host, ccsid: 930, deviceName: PRTDEV, warn: (m) => log(`  [warn] ${m}`), // log は装置名を伏せる
    respondAfter: (r, ctx) => {
      // 帳票ができるたびに控える（CLEAR で閉じた帳票も——取り消しで白紙の帳票ができないかを見る）
      log(`  [帳票] cleared=${ctx.cleared} raw=${r.raw.length}B ページ=${r.pages.length} 本文=${JSON.stringify(r.pages.map((p) => p.lines.join("").trim()).join("|").slice(0, 40))}`);
      if (ctx.cleared) return;
      held++;
      return new Promise((res) => { releaseGate = res; });
    }
  });
  log(`  起動応答: ${prt.startupCode}`);
  // 受けたレコードと返したレコードを控える（private だが実行時は触れる。測定のためだけ）。
  // 解いたとき溜めたレコードはこの onRecord を通って再投入されるので `seen` に 2 度目が積まれる——解く前に切り出すこと
  const origOnRecord = prt.onRecord.bind(prt);
  prt.onRecord = (rec) => { seen.push({ at: Date.now(), heldQueue: prt.held !== undefined, head: hex(rec), op: rec[9], misc: rec[4], flag1: rec[7], len: rec.length }); origOnRecord(rec); };
  const origSend = prt.telnet.sendRecord.bind(prt.telnet);
  prt.telnet.sendRecord = (rec) => { sent.push({ at: Date.now(), tail: rec[rec.length - 1] }); origSend(rec); };
  let closed;
  prt.on("closed", (r) => { closed = r; });

  // 繋ぐとホストが書き出しプログラムを自動で起こすが、既定の書式（*STD）で用紙の問い合わせ（CPA3394）を QSYSOPR に出して
  // MSGW で止まり、帳票が届かない（2 回目の実測）。止めて、書式を問わず知らせもしない設定で起こし直す
  await run(`ENDWTR WTR(${PRTDEV}) OPTION(*IMMED)`);
  await sleep(3000);
  const since = await nowTs();
  await run(`STRPRTWTR DEV(${PRTDEV}) OUTQ(${PRTDEV}) FORMTYPE(*ALL *NOMSG)`);
  await run(`CHGJOB OUTQ(${PRTDEV})`);
  await run("DSPLIBL OUTPUT(*PRINT)");
  for (let i = 0; i < 30 && held === 0; i++) {
    await sleep(1000);
    if (i % 3 === 2) await answerAlign(since);
  }
  log(`  帳票が届いて応答を止めた=${held >= 1}  スプール=${await spools()}  書き出し=${await writer()}  受けたレコード=${seen.length}`);
  const target = (await mine()).slice(-1)[0];
  if (held === 0 || !target) {
    // 帳票が届いていない（書き出しプログラムが止まっている等）——取り消しを測れないので、この回は打ち切る
    log("  ⚠ 帳票が届かなかったのでこの回は打ち切る");
    prt.disconnect();
    await run(`ENDWTR WTR(${PRTDEV}) OPTION(*IMMED)`);
    continue;
  }
  const t0 = Date.now();
  const nBefore = seen.length;
  if (cancel) {
    await run(cancel(target));
    await sleep(10000);
  } else {
    for (let m = 1; m <= IDLE_MIN; m++) {
      await sleep(60000);
      log(`  止めて ${m} 分: スプール=${await spools()}  書き出し=${await writer()}  接続=${closed ? `切れた(${closed})` : "つながったまま"}`);
      if (closed) break;
    }
  }
  const after = seen.slice(nBefore);
  const phase = cancel ? "取り消して 10 秒" : `止めて ${IDLE_MIN} 分の後`;
  log(`  ${phase}: スプール=${await spools()}  書き出し=${await writer()}  接続=${closed ? `切れた(${closed})` : "つながったまま"}`);
  log(`  ${cancel ? "取り消しの後" : "止めている間"}に届いたレコード=${after.length} ${after.map((r) => `[op=${r.op} misc=0x${r.misc.toString(16)} flag1=0x${r.flag1.toString(16)} len=${r.len} 止めている間=${r.heldQueue} +${r.at - t0}ms ${r.head}]`).join(" ")}`);
  log(`  それまでに返した応答=${sent.map((s) => (s.tail === 1 ? "NO_ERROR" : s.tail === 2 ? "CLEAR_PROCESSED" : `?${s.tail}`)).join(",") || "(無し)"}`);
  const nSent = sent.length;
  const nSeen = seen.length;
  releaseGate?.();
  await sleep(5000);
  // 解いた後に届いたレコード（溜めていた分の再投入を除く＝溜めた本数を差し引いた残り）
  const fresh = seen.slice(nSeen).slice(after.length);
  log(`  解いた後に新たに届いたレコード=${fresh.length} ${fresh.map((r) => `[op=${r.op} flag1=0x${r.flag1.toString(16)} len=${r.len}]`).join(" ")}`);
  log(`  応答を解いた後に返した応答=${sent.slice(nSent).map((s) => (s.tail === 1 ? "NO_ERROR" : s.tail === 2 ? "CLEAR_PROCESSED" : `?${s.tail}`)).join(",") || "(無し)"}  スプール=${await spools()}  接続=${closed ? `切れた(${closed})` : "つながったまま"}`);
  await sleep(3000);
  log(`  さらに 3 秒: スプール=${await spools()}`);
  prt.disconnect();
  await run(`ENDWTR WTR(${PRTDEV}) OPTION(*IMMED)`);
  await sleep(3000);
}

} finally {
log("\n--- 片付け ---");
prt?.disconnect();
await cc.run(`ENDWTR WTR(${PRTDEV}) OPTION(*IMMED)`).catch(() => {});
for (const sp of await mine()) await run(`DLTSPLF FILE(QPRTLIBL) JOB(${sp.JOB_NAME}) SPLNBR(${sp.FILE_NUMBER})`);
log(`  残り: ${await spools()}`);
await db.close();
await cc.close();
}
process.exit(0);
