// MSGW（スプールがライターの問い合わせで止まっている状態）で
// `retrieveMessage` / `answerMessage` が期待どおり動くかを実機で確かめる。
//
// `20260718-hostserver-msgw` の最大の穴。PUB400 では権限不足（CPF3464）で
// writer を常駐させられず、**メッセージが有る場合を一度も通していない**。
// とくに `answerMessage` は応答文字列だけ NUL 終端で送っており、
// MSGREPLY が固定長を要求するなら隣の値を巻き込む恐れがある——それを確かめる。
//
// 実行: AS400_HOST=... AS400_USER=... AS400_PASSWORD=... node --env-file=.env --env-file=.env.verify \
//         scripts/research-msgw.mjs
//
// 副作用: 仮想プリンター装置（毎回別名）と自分のジョブのスプールを 1 件作る。
// 最後にスプールを消す。**他人の OUTQ には触らない。**
import { PrinterSession } from "@ts5250/tn5250";
import { CommandConnection, NetPrintConnection, listSpooledFiles } from "@ts5250/hostserver";

const host = process.env.AS400_HOST;
const user = process.env.AS400_USER;
const password = process.env.AS400_PASSWORD;
if (!host || !user || !password) {
  process.stderr.write("AS400_HOST / AS400_USER / AS400_PASSWORD を環境変数で渡してください\n");
  process.exit(2);
}

/**
 * **既存の仮想プリンター装置を使う。**
 *
 * 実機は `QAUTOVRT=200` / `QAUTOCFG=1` にもかかわらず、プリンターの自動構成を
 * 断る（`8940: Automatic configuration failed or not allowed`）。自分で
 * `CRTDEVPRT DEVCLS(*VRT)` を作っても、コントローラー指定が無いと `VRYCFG` が
 * `CPF2640` で落ち、セッションも `8903: Device not valid for session` になる。
 * よって**既にある装置を借りる**（利用者の指定）。
 */
const PRTDEV = process.env.AS400_PRTDEV ?? "PRT_TEST";
const FORMTYPE = "AIDEVMSGW";

const log = (s) => process.stdout.write(s + "\n");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0;
let fail = 0;
const check = (cond, msg) => {
  if (cond) { pass++; log(`  PASS ${msg}`); } else { fail++; log(`  FAIL ${msg}`); }
};

const cmd = async (c, s) => {
  const r = await c.run(s);
  log(`  cmd ${s} → rc=0x${r.returnCode.toString(16)}${r.messages?.length ? " " + r.messages.map((m) => m.id).join(",") : ""}`);
  return r;
};

let prt;
let np;
let cc;
let spoolId;
try {
  cc = await CommandConnection.connect({ host, user, password });

  // ---- 1. 装置を使える状態にする（**作らない。借りるだけ**） ----
  await cmd(cc, `VRYCFG CFGOBJ(${PRTDEV}) CFGTYPE(*DEV) STATUS(*ON)`);

  // ---- 2. プリンターセッションを開く（ホストがライターを起動する） ----
  prt = await PrinterSession.connect({ host, port: 23, deviceName: PRTDEV, user, password });
  log(`プリンター起動: ${prt.startupCode} device=${PRTDEV}`);
  const reports = [];
  prt.on("report", (r) => reports.push(r));

  // ---- 3. 自分のジョブのスプールをその OUTQ へ回す ----
  // **用紙タイプをずらす**——一致していればライターは何も聞かず、MSGW にならない
  await cmd(cc, `CHGJOB OUTQ(${PRTDEV})`);
  // **上書きするのは `QPRTLIBL`**——`DSPLIBL OUTPUT(*PRINT)` が作るスプールの名前。
  // `QPDSPLIB` を上書きしても効かず、用紙タイプが揃ったままライターが印刷してしまう（踏んだ）
  await cmd(cc, `OVRPRTF FILE(QPRTLIBL) FORMTYPE(${FORMTYPE}) OVRSCOPE(*JOB)`);
  await cmd(cc, "DSPLIBL OUTPUT(*PRINT)");
  await sleep(3000);

  // ---- 3. MSGW のスプールを探す ----
  np = await NetPrintConnection.connect({ host, user, password });
  // **一覧はコマンドサーバー経由**（`listSpooledFiles` は CommandConnection を取る）
  const spools = await listSpooledFiles(cc, { user }, { max: 400 });
  const mine = spools.filter((s) => s.outputQueue?.includes(PRTDEV) || s.formType?.trim() === FORMTYPE);
  log(`\n自分のスプール ${spools.length} 件中、この検証のもの ${mine.length} 件`);
  for (const s of mine) log(`  ${s.fileName}#${s.fileNumber} status=${s.status} form=${s.formType} outq=${s.outputQueue}`);
  const target = mine.find((s) => /MSGW/i.test(s.status ?? "")) ?? mine[0];
  check(Boolean(target), "検証対象のスプールが見つかる");
  if (!target) throw new Error("スプールが無い");
  spoolId = { jobName: target.jobName, jobUser: target.jobUser, jobNumber: target.jobNumber, fileName: target.fileName, fileNumber: target.fileNumber };
  // 一覧の状態名は `MESSAGE_WAIT`（`MSGW` は画面表記）
  check(/MESSAGE_WAIT|MSGW/i.test(target.status ?? ""), `状態が MSGW（実際: ${target.status}）`);

  // ---- 4. retrieveMessage ----
  log("\n### retrieveMessage");
  const msg = await np.retrieveMessage(spoolId);
  if (!msg) {
    check(false, "メッセージが取れる");
  } else {
    log(`  id=${msg.id}`);
    log(`  text=${msg.text}`);
    log(`  help=${(msg.help ?? "").slice(0, 120)}`);
    log(`  handle=${msg.handle ? `${msg.handle.length} バイト` : "なし"}`);
    check(Boolean(msg.id), `メッセージ ID が取れる（${msg.id}）`);
    // **本文が化けていないか**。ID は英数字なのでどの CCSID でも読めてしまい、
    // 本文だけが壊れる（CCSID 37 決め打ちだったときに実際に踏んだ）
    check(msg.text.includes(PRTDEV), `本文に装置名が読める形で入る（CCSID が合っている）`);
    check(Boolean(msg.handle), "ハンドルが返る（これが無いと応答できない）");

    // ---- 5. answerMessage ----
    log("\n### answerMessage");
    try {
      await np.answerMessage(msg, "I"); // I = 現用紙のまま印刷
      check(true, "answerMessage が成功する（NUL 終端の応答が受理された）");
    } catch (e) {
      check(false, `answerMessage が成功する（${e?.code ?? ""} ${e?.message ?? e}）`);
    }

    // ---- 6. MSGW が解けたか ----
    await sleep(3000);
    const after = (await listSpooledFiles(cc, { user }, { max: 400 })).find(
      (s) => s.fileName === target.fileName && s.fileNumber === target.fileNumber
    );
    log(`  応答後の状態: ${after?.status ?? "（一覧から消えた＝印刷された）"}`);
    check(!after || !/MESSAGE_WAIT|MSGW/i.test(after.status ?? ""), "MSGW が解けている");

    const t0 = Date.now();
    while (Date.now() - t0 < 15000 && reports.length === 0) await sleep(500);
    check(reports.length >= 1, `応答後にスプールが届く（実際: ${reports.length} 件)`);
  }
} finally {
  // ---- 後始末 ----
  try { if (np && spoolId) await np.deleteSpooledFile(spoolId); } catch { /* 消えていれば良い */ }
  try { if (cc) await cc.run("DLTOVR FILE(QPRTLIBL) LVL(*JOB)"); } catch { /* 無ければ良い */ }
  // **借りた装置は消さない**。ライターだけ必ず止める（起動したのはこちらなので）
  try { if (cc) await cc.run(`ENDWTR WTR(${PRTDEV}) OPTION(*IMMED)`); } catch { /* 動いていなければ良い */ }
  np?.close?.();
  cc?.close?.();
  prt?.disconnect?.();
}

log(`\n${fail === 0 ? "OK" : "NG"} — ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
