// **応答待ちの見え方を実機で確かめるための CL 一式**を作る（冪等）。
//
//   node --env-file=.env --env-file=.env.verify scripts/build-msgloop.mjs
//
// | 作るもの | 何が起きるか |
// |---|---|
// | `MSGLOOP` | 60 秒・1 秒ごとに `SNDMSG`（利用者の待ち行列へ）。**画面には何も来ない** |
// | `STSLOOP` | 60 秒・1 秒ごとに状況メッセージ（`TOPGMQ(*EXT) MSGTYPE(*STATUS)`）。**施錠されたままの画面が降ってくる** |
// | `MSGWTST` | **画面以外**（`<AS400_LIB>/INQMSGQ`）にメッセージが来るまで待つ。ジョブは **MSGW**、画面は沈黙したまま。解放は `SNDMSG MSG('GO') TOMSGQ(<AS400_LIB>/INQMSGQ)` |
// | `MSGWRPY` | 照会（`CPA0701` 等）に鍵を指定して答える。ジョブが応答待ちで固まったときの後始末 |
// | `MSGCLR` | `MSGLOOP` が積んだメッセージを鍵で 1 通ずつ消す（後始末） |
//
// `<AS400_LIB>/MSGLOOP` は 60 秒間、**1 秒ごとに `SNDMSG` で進捗を送る**だけのプログラム:
//
// ```
// PGM
//   RTVJOBA USER(&U)
//   LOOP: &I = &I + 1
//         SNDMSG MSG('MSGLOOP nnn/060 RUNNING') TOUSR(&U)
//         DLYJOB DLY(1)
//         IF (&I < 60) GOTO LOOP
//   SNDMSG MSG('MSGLOOP DONE 060/060') TOUSR(&U)
// ENDPGM
// ```
//
// ## なぜこの形か
//
// 応答タイムアウトを廃した（#388）あと「**ローディングが解除されない**」という報告が出た。
// 待ちを解く合図は 2 つしかない——**施錠が解けた画面**か `key-done`——ので、
// 「ホストが応答の途中で画面を書いてくる」最中に何が届くのかを実機で見る必要がある。
//
// `SNDMSG` は**画面を書き換えずにホストが端末へ何かを送る**数少ない手段で、
// 受け側の待ち行列の配信方式によって届き方が変わる:
//
//   *NOTIFY（既定） … メッセージ通知ランプだけが点く（5250 の opcode `MESSAGE_LIGHT_ON`）。
//                      **画面は施錠されたまま**なので、待ちを解いてはいけない側の材料
//   *BREAK          … 割り込んでメッセージ画面が出る。**施錠が解ける**ので待ちも解ける
//
// どちらでも「60 秒後にプログラムが終わったら待ちが解けるか」は同じ問いになる。
// 検証は `scripts/verify-browser-msgloop-loading.mjs`（実ブラウザでスピナーを見る）。
//
// **宛先はジョブのユーザーの待ち行列**（`RTVJOBA USER` → `TOUSR(&U)`）。`TOUSR(*REQUESTER)` は
// 対話ジョブでは**装置の待ち行列**へ行き、装置側の配信方式（多くは *BREAK）に引きずられて
// 「60 回割り込まれる」形になりかねないので採らない。
//
// ソースは**SQL の INSERT で流し込む**（`build-pgmtst.mjs` と同じ手口。IFS も FTP も要らない）。
import { readFileSync } from "node:fs";
import { CommandConnection, DbConnection, executeStatement } from "@ts5250/hostserver";
import { SecretCrypto } from "../packages/server/dist/secret-crypto.js";

const LIB = process.env.AS400_LIB ?? "TESTLIB";
const SRCF = "QCLSRC";
const MBR = "MSGLOOP";
/** 何秒回すか。**既定 60**（報告のあった「長い処理」の再現） */
const SECS = Number(process.env.MSGLOOP_SECS ?? 60);
const log = (s) => process.stdout.write(s + "\n");

/**
 * 接続先。環境変数が揃っていればそれを使い、無ければ設定ファイルから読む
 * （`build-sqldemo.mjs` と同じ引き方。この機械では実機が `profiles.local.json` にある）。
 */
function target() {
  if (process.env.AS400_HOST && process.env.AS400_USER && process.env.AS400_PASSWORD) {
    return {
      host: process.env.AS400_HOST,
      user: process.env.AS400_USER,
      password: process.env.AS400_PASSWORD
    };
  }
  for (const file of ["profiles.local.json", "connections.json"]) {
    let cfg;
    try {
      cfg = JSON.parse(readFileSync(file, "utf8"));
    } catch {
      continue;
    }
    const sys = (cfg.systems ?? []).find((s) => s.name === (process.env.AS400_SYSTEM ?? "AS400"));
    if (!sys?.signon?.passwordEnc) continue;
    const crypto = SecretCrypto.fromEnv();
    if (!crypto) break;
    return { host: sys.host, user: sys.signon.user, password: crypto.decrypt(sys.signon.passwordEnc) };
  }
  log("接続先が分かりません。AS400_HOST / AS400_USER / AS400_PASSWORD を渡すか、");
  log("profiles.local.json に実機を置いて --env-file=.env --env-file=.env.verify で実行してください。");
  process.exit(2);
}

/** 3 桁ゼロ詰め（メッセージの見た目を揃えるだけ。CL の *DEC → *CHAR 変換に合わせて 3 桁） */
const n3 = String(SECS).padStart(3, "0");

/**
 * CL ソース。**ラベルはコマンドと同じ行に置く**（単独行のラベルは書式として通らない）。
 * `&C` は `*DEC(3 0)` からの変換先なので**きっかり 3 桁**にする（長さが違うと CPD0084 系で落ちる）。
 */
const SOURCE = [
  "PGM",
  "DCL VAR(&I) TYPE(*DEC) LEN(3 0) VALUE(0)",
  "DCL VAR(&C) TYPE(*CHAR) LEN(3)",
  "DCL VAR(&U) TYPE(*CHAR) LEN(10)",
  "RTVJOBA USER(&U)",
  "LOOP: CHGVAR VAR(&I) VALUE(&I + 1)",
  "CHGVAR VAR(&C) VALUE(&I)",
  `SNDMSG MSG('MSGLOOP' *BCAT &C *BCAT '/${n3} RUNNING') TOUSR(&U)`,
  "DLYJOB DLY(1)",
  `IF COND(&I *LT ${SECS}) THEN(GOTO CMDLBL(LOOP))`,
  `SNDMSG MSG('MSGLOOP DONE ${n3}/${n3}') TOUSR(&U)`,
  "ENDPGM"
];

/**
 * **画面に出る進捗**（`<AS400_LIB>/STSLOOP`）。中身は MSGLOOP と同じ 1 秒刻みだが、
 * 送り先が**表示装置そのもの**（`TOPGMQ(*EXT) MSGTYPE(*STATUS)`）。
 *
 * MSGLOOP を実機で回して分かったこと: **`SNDMSG` は表示セッションに何も届けない**
 * （待ち行列に積まれるだけ。60 秒のあいだ 5250 のレコードは 1 本も来なかった）。
 * それだと #388 で入れた規則——**施錠されたままの画面では待ちを解かない**——を
 * 一度も通らないので、「ローディングが解除されない」の検証にならない。
 *
 * 状況メッセージは**ホストが応答の途中で画面を書いてくる**唯一の素直な手段で、
 * その画面は施錠されたまま届く。ここを通してはじめて、
 * 「途中の画面で待ちを解いてしまわないか」「終わったら解けるか」の両方を実地で見られる。
 *
 * `*STATUS` は**メッセージ ID が要る**（自由文の `MSG()` は使えない）ので `CPF9898` に載せる。
 */
const STS_MBR = "STSLOOP";
const STS_SOURCE = [
  "PGM",
  "DCL VAR(&I) TYPE(*DEC) LEN(3 0) VALUE(0)",
  "DCL VAR(&C) TYPE(*CHAR) LEN(3)",
  "LOOP: CHGVAR VAR(&I) VALUE(&I + 1)",
  "CHGVAR VAR(&C) VALUE(&I)",
  "SNDPGMMSG MSGID(CPF9898) MSGF(QCPFMSG) +",
  `  MSGDTA('STSLOOP' *BCAT &C *BCAT '/${n3} PROCESSING') +`,
  "  TOPGMQ(*EXT) MSGTYPE(*STATUS)",
  "DLYJOB DLY(1)",
  `IF COND(&I *LT ${SECS}) THEN(GOTO CMDLBL(LOOP))`,
  "ENDPGM"
];

/**
 * **照会で MSGW になるプログラム**（`<AS400_LIB>/MSGWTST`）。「分岐 2」の再現用。
 *
 * 呼んだプログラムが MSGW（応答待ち）になったとき、画面がどうなるかは
 * **その照会がどこへ出るか**で 2 通りに分かれる:
 *
 *   画面（`TOPGMQ(*EXT)`）へ出る … ホストが「プログラム・メッセージの表示」を書いて**解錠する**。
 *                                   画面側の待ちはそこで解け、利用者は答えられる（＝困らない）
 *   画面以外へ出る               … 表示装置には**1 バイトも届かない**。ホストは Read を出さないので
 *                                   `key-done` も来ず、**ローディングが出たまま**になる（＝これ）
 *
 * ここは後者を狙って作る。待つ先は **`<AS400_LIB>/INQMSGQ`**——`QSYSOPR` で待つと
 * 実機の運用メッセージを横取りしてしまうので、**自前の待ち行列**を作る。
 * `RCVMSG … WAIT(*MAX)` で待つ間、ジョブの状況は `MSGW`（実機で確認）。
 *
 * **抜け方は 3 つ**: 端末から `SysReq`→「2. 前の要求の終了」（これが検証の主題）／
 * `SNDMSG MSG('GO') TOMSGQ(<AS400_LIB>/INQMSGQ)`（コマンドサーバーからも打てる）／
 * 最後の手段として `ENDJOB`。
 */
const INQ_MSGQ = "INQMSGQ";
const MSGW_MBR = "MSGWTST";
const MSGW_SOURCE = [
  "PGM",
  "DCL VAR(&R) TYPE(*CHAR) LEN(80)",
  "DCL VAR(&EID) TYPE(*CHAR) LEN(7)",
  // **`TOPGMQ(*EXT)` へは何も送らない。** 対話ジョブでは *EXT の `*INFO` が
  // 「プログラム・メッセージの表示」画面になって出てしまい、**実行キーを 1 回押させてから**
  // 止まる形になる（利用者の報告）。狙いは「CALL した瞬間から固まる」ことなので、
  // 途中に画面を挟まない。何を待っているかはジョブログと `INQMSGQ` の名前で足りる
  // **`MSGTYPE(*ANY)` で待つ。** 実機で確かめた回り道:
  //   `SNDPGMMSG … TOMSGQ(…) MSGTYPE(*INQ) KEYVAR(&K)` の鍵は**非プログラム待ち行列の鍵として
  //   通らず**、`RCVMSG … MSGKEY(&K) MSGTYPE(*RPY)` は `CPF2410`（鍵が見つからない）で即落ちる
  //   鍵を外して `MSGTYPE(*RPY)` にすると今度は**応答を置いても起きない**（MSGW のまま）
  // 「待ち行列に何か来るまで待つ」だけなら `*ANY` が確実で、目的（ジョブを MSGW にする）は同じ
  `RCVMSG MSGQ(${LIB}/${INQ_MSGQ}) MSGTYPE(*ANY) +`,
  "  WAIT(*MAX) RMV(*YES) MSG(&R)",
  "MONMSG MSGID(CPF0000) EXEC(GOTO CMDLBL(FAIL))",
  "RETURN",
  // **黙って落ちない。** ここへ来た理由（メッセージ ID）を待ち行列へ置く——
  // `MONMSG` で握るだけにすると「待つはずが即終わった」が無言になり、外から追えない
  "FAIL: RCVMSG PGMQ(*SAME) MSGTYPE(*EXCP) RMV(*YES) MSGID(&EID)",
  "MONMSG MSGID(CPF0000)",
  `SNDPGMMSG MSG('MSGWTST failed:' *BCAT &EID) TOMSGQ(${LIB}/${INQ_MSGQ}) MSGTYPE(*INFO)`,
  "MONMSG MSGID(CPF0000)",
  "ENDPGM"
];

/**
 * **照会に答える道具**（`<AS400_LIB>/MSGWRPY`）。待ち行列・鍵・応答を渡して 1 件だけ答える。
 *
 * `SNDRPY` は**コマンドサーバーから直に打てない**（`CPD0031`。CL プログラムの中でしか
 * 許されていない）ので、`MSGCLR` と同じく 1 本の CL に包む。
 *
 * **`RMV(*NO)` が肝。** 既定の `RMV(*YES)` は照会と応答を待ち行列から消してしまい、
 * `WAIT(*MAX)` で待っている側の `RCVMSG` が鍵を見失って `CPF2410` で落ちる
 * （実機で踏んだ——答えたのにジョブが解放されず、逆に関数チェックで固まった）。
 *
 * **鍵で狙い撃つ。** 「待ち行列の先頭に答える」形にすると、`QSYSOPR` のような
 * 共用の待ち行列で**他人の照会に勝手に答えて**しまう。鍵は呼び出し側が
 * `QSYS2.MESSAGE_QUEUE_INFO` から選ぶ。
 *
 * **`MONMSG` は外さない**（`MSGCLR` の注記と同じ理由）。
 */
const MSGW_RPY_MBR = "MSGWRPY";
const MSGW_RPY_SOURCE = [
  "PGM PARM(&QLIB &QNAME &KEY &RPY)",
  "DCL VAR(&QLIB) TYPE(*CHAR) LEN(10)",
  "DCL VAR(&QNAME) TYPE(*CHAR) LEN(10)",
  "DCL VAR(&KEY) TYPE(*CHAR) LEN(4)",
  "DCL VAR(&RPY) TYPE(*CHAR) LEN(1)",
  "SNDRPY MSGKEY(&KEY) MSGQ(&QLIB/&QNAME) RPY(&RPY) RMV(*NO)",
  "MONMSG MSGID(CPF0000)",
  "ENDPGM"
];

/**
 * **後始末の道具**（`<AS400_LIB>/MSGCLR`）。渡された鍵のメッセージを 1 通だけ消す。
 *
 * MSGLOOP は利用者のメッセージ待ち行列に 60 通あまりを積む。検証のたびに溜まるので
 * 消したいが、**`RMVMSG` はコマンドサーバーから直に打てない**——`CPD0031`
 * （`Command RMVMSG not allowed in this setting.`）で弾かれ、`QCMDEXC` 経由でも同じ。
 * CL プログラムの中でしか許されていないコマンドなので、**1 通ぶんの CL** を置く。
 *
 * **鍵で消す**（`CLEAR(*BYKEY)`）。`CLEAR(*ALL)` にすると利用者の他のメッセージまで
 * 巻き込むので、消すものは呼び出し側が SQL（`QSYS2.MESSAGE_QUEUE_INFO`）で選ぶ。
 *
 * **待ち行列は引数で受け取る。** `RTVJOBA USER()` で取ると、コマンドサーバーの
 * 事前開始ジョブ（`QZRCSRVS`）では**ジョブのユーザー `QUSER`** が返り、`QUSRSYS/QUSER` を
 * 消しにいって `CPF2410`（鍵が無い）になる（実機で踏んだ）。
 *
 * **`MONMSG` は外さない。** 外すと `CPF2410` が関数チェックまで上がり、サーバージョブが
 * `CPA0701` の応答待ち（MSGW）で**固まって残る**——古い鍵を渡しただけで
 * 事前開始ジョブを 1 本潰すことになる（これも実機で踏んだ）。
 */
const CLR_MBR = "MSGCLR";
const CLR_SOURCE = [
  "PGM PARM(&MSGQ &KEY)",
  "DCL VAR(&MSGQ) TYPE(*CHAR) LEN(10)",
  "DCL VAR(&KEY) TYPE(*CHAR) LEN(4)",
  "RMVMSG MSGQ(QUSRSYS/&MSGQ) MSGKEY(&KEY) CLEAR(*BYKEY)",
  "MONMSG MSGID(CPF0000)",
  "ENDPGM"
];

const { host, user, password } = target();
const cmd = await CommandConnection.connect({ host, user, password });
const db = await DbConnection.connect({ host, user, password });
try {
  log(`${host} / ${user} / ${LIB}/${MBR}（${SECS} 秒）`);

  // ソース物理ファイルが無い実機もある。**あれば CPF7302 で返るだけ**なので黙って通す
  const crtf = await cmd.run(`CRTSRCPF FILE(${LIB}/${SRCF}) RCDLEN(112) TEXT('CL source')`);
  log(`CRTSRCPF ${SRCF}`.padEnd(44) + ` → ${crtf.success ? "作った" : (crtf.messages[0]?.id ?? "既にある")}`);

  /** 1 本ぶん作る（**冪等**——作り直せるように、あるものは消してから作る） */
  async function build(member, source) {
    for (const c of [`DLTPGM PGM(${LIB}/${member})`, `RMVM FILE(${LIB}/${SRCF}) MBR(${member})`]) {
      const r = await cmd.run(c);
      log(`${c.padEnd(44)} → ${r.success ? "消した" : (r.messages[0]?.id ?? "無かった")}`);
    }

    const add = await cmd.run(`ADDPFM FILE(${LIB}/${SRCF}) MBR(${member}) SRCTYPE(CLP)`);
    log(`ADDPFM ${member}`.padEnd(44) + ` → ${add.success ? "OK" : add.messages[0]?.id}`);
    if (!add.success) throw new Error(`${member} のメンバーを作れませんでした`);

    // ソースを SQL で流し込む。**1 行 = 1 リテラル**。
    // **別名でメンバーを指す**——SQL からソース物理ファイルの特定メンバーへ書くには別名が要る
    const alias = `${member}A`;
    await executeStatement(db, `DROP ALIAS ${LIB}.${alias}`).catch(() => undefined);
    await executeStatement(db, `CREATE ALIAS ${LIB}.${alias} FOR ${LIB}.${SRCF} (${member})`);
    for (const [i, line] of source.entries()) {
      await executeStatement(
        db,
        `INSERT INTO ${LIB}.${alias} (SRCSEQ, SRCDAT, SRCDTA) ` +
          `VALUES (${(i + 1) * 100}, 0, '${line.replace(/'/gu, "''")}')`
      );
    }
    await executeStatement(db, `DROP ALIAS ${LIB}.${alias}`).catch(() => undefined);
    log(`ソース ${source.length} 行を投入`);

    const crt = await cmd.run(`CRTCLPGM PGM(${LIB}/${member}) SRCFILE(${LIB}/${SRCF}) SRCMBR(${member})`);
    log(
      `CRTCLPGM ${member}`.padEnd(44) +
        ` → ${crt.success ? "OK" : crt.messages.map((m) => `${m.id} ${m.text}`).join(" / ")}`
    );
    if (!crt.success) throw new Error(`${member} のコンパイルに失敗しました`);
  }

  // 照会の宛先。**自前の待ち行列**にして QSYSOPR を汚さない（`MSGWTST` の注記）。
  // 既にあれば `CPF2112` で返るだけなので黙って通す
  const crtq = await cmd.run(`CRTMSGQ MSGQ(${LIB}/${INQ_MSGQ}) TEXT('MSGWTST inquiry queue')`);
  log(`CRTMSGQ ${INQ_MSGQ}`.padEnd(44) + ` → ${crtq.success ? "作った" : (crtq.messages[0]?.id ?? "既にある")}`);

  await build(MBR, SOURCE);
  await build(STS_MBR, STS_SOURCE);
  await build(MSGW_MBR, MSGW_SOURCE);
  await build(MSGW_RPY_MBR, MSGW_RPY_SOURCE);
  await build(CLR_MBR, CLR_SOURCE);

  log(`\n${LIB}/${MBR}   → CALL ${LIB}/${MBR}    ${SECS} 秒・1 秒ごとに SNDMSG（待ち行列へ）`);
  log(`${LIB}/${STS_MBR}   → CALL ${LIB}/${STS_MBR}    ${SECS} 秒・1 秒ごとに状況メッセージ（画面へ）`);
  log(`${LIB}/${MSGW_MBR}   → CALL ${LIB}/${MSGW_MBR}    MSGW で止まる（画面は沈黙・ローディングが残る）`);
  log(`${LIB}/${MSGW_MBR}   ↑ 解放は SNDMSG MSG('GO') TOMSGQ(${LIB}/${INQ_MSGQ})`);
  log(
    `${LIB}/${MSGW_RPY_MBR}   → CALL ${LIB}/${MSGW_RPY_MBR} PARM('QSYS' 'QSYSOPR' X'鍵' 'C')  照会に鍵を指定して答える`
  );
  log(`${LIB}/${CLR_MBR}   → 検証スクリプトが積んだメッセージの後始末に使う（鍵で 1 通ずつ）`);
} finally {
  cmd.close?.();
  db.close?.();
}
