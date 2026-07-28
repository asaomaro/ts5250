// 実機の TESTLIB に STRPCO / STRPCCMD のテスト用 CL を作成・コンパイルする（冪等）。
//
//   PCOTEST — データ域 PCOCMD / PCOWAIT からコマンドと PAUSE を読み、STRPCO → STRPCCMD を実行。
//             STRPCCMD の**前後**でデータ域 PCOMARK を BEFORE / AFTER に書き換えるので、
//             CL が STRPCCMD の先へ進んだかを画面に頼らず確かめられる。
//   PCOLONG — 200 文字のコマンドで STRPCCMD（データストリーム上の配置確認用）。
//
// **パラメーターではなくデータ域で渡す**のは、CL の CALL が文字リテラルを 32 バイトに詰めて
// 渡すため（宣言長と食い違うと領域を踏む）と、5250 のコマンド行が 100 桁しかないため。
//
// ソース投入は IFS/FTP 不要。RUNSQL で QTMPSRC に入れて CPYF で移す（build-gridtest3.mjs と同方式。
// **ADDPFM の SRCTYPE(CLP) が要る**——省くとコンパイラがソース種別を決められず CPF0820 で落ちる）。
// 実行: node --env-file=.env scripts/build-pcotest.mjs
import { readFileSync } from "node:fs";
import { CommandConnection } from "@as400web/core";
import { SecretCrypto } from "../packages/server/dist/secret-crypto.js";

const LIB = process.env.AS400_LIB ?? "TESTLIB";
const log = (s) => process.stdout.write(s + "\n");
const I = " ".repeat(13); // 命令の開始桁（固定形式の慣例）

const PCOTEST = [
  `${I}PGM`,
  `${I}DCL        VAR(&CMD) TYPE(*CHAR) LEN(123)`,
  `${I}DCL        VAR(&WAIT) TYPE(*CHAR) LEN(4)`,
  `${I}RTVDTAARA  DTAARA(${LIB}/PCOCMD) RTNVAR(&CMD)`,
  `${I}RTVDTAARA  DTAARA(${LIB}/PCOWAIT) RTNVAR(&WAIT)`,
  `${I}CHGDTAARA  DTAARA(${LIB}/PCOMARK) VALUE('BEFORE    ')`,
  `${I}STRPCO`,
  `${I}IF         COND(&WAIT *EQ '*NO ') THEN(DO)`,
  `${I}STRPCCMD   PCCMD(&CMD) PAUSE(*NO)`,
  `${I}ENDDO`,
  `${I}ELSE       CMD(DO)`,
  `${I}STRPCCMD   PCCMD(&CMD) PAUSE(*YES)`,
  `${I}ENDDO`,
  `${I}CHGDTAARA  DTAARA(${LIB}/PCOMARK) VALUE('AFTER     ')`,
  `${I}SNDPGMMSG  MSG('PCOTEST DONE') MSGTYPE(*COMP)`,
  `${I}ENDPGM`,
];

// 長いコマンドを CL 内で組み立てる（コマンド行の桁制限を受けないため）。
// 桁が数えられるよう 10 文字ごとに通番を振る。
const CHUNK = (n) => `X${String(n).padStart(2, "0")}4567890`; // 10 文字
const longPgm = (len, name) => {
  const n = Math.floor(len / 10);
  const rest = len - n * 10;
  return [
    `${I}PGM`,
    `${I}DCL        VAR(&C) TYPE(*CHAR) LEN(${len})`,
    // **STRPCO を先に実行しないとホストは PCO 標識を送ってこない**（実測。research D2）
    `${I}STRPCO`,
    ...Array.from({ length: n }, (_, i) =>
      i === 0
        ? `${I}CHGVAR     VAR(&C) VALUE('${CHUNK(i)}')`
        : `${I}CHGVAR     VAR(&C) VALUE(&C *TCAT '${CHUNK(i)}')`
    ),
    ...(rest > 0 ? [`${I}CHGVAR     VAR(&C) VALUE(&C *TCAT '${"Z".repeat(rest)}')`] : []),
    `${I}STRPCCMD   PCCMD(&C) PAUSE(*NO)`,
    `${I}SNDPGMMSG  MSG('${name} DONE') MSGTYPE(*COMP)`,
    `${I}ENDPGM`,
  ];
};

const PGMS = [
  { name: "PCOTEST", src: PCOTEST },
  // 123 桁: 属性(1)+標識(10)+PAUSE(1)+123 = 135 で 27x132 の 1 行(132)を越える（折返しの実測用）。
  // 200 桁は実機が受け付けず応答待ちメッセージでジョブが止まったので置かない（research D4）
  { name: "PCO123", src: longPgm(123, "PCO123") },
];

const conns = JSON.parse(readFileSync("connections.json", "utf8"));
const sys = conns.systems.find((s) => s.name === "実機");
const password = SecretCrypto.fromEnv().decrypt(sys.signon.passwordEnc);

const connect = async () => {
  for (let a = 1; ; a++) {
    try {
      return await CommandConnection.connect({
        host: sys.host, user: sys.signon.user, password, ccsid: sys.ccsid ?? 37,
        resolvePort: true, timeoutMs: 40_000,
      });
    } catch (e) {
      if (a >= 4) throw e;
      log(`(接続やり直し ${a}: ${e.code})`);
      await new Promise((r) => setTimeout(r, 5000));
    }
  }
};
const cn = await connect();
const show = (r, label) => {
  const bad = r.messages.filter((m) => m.kind === "error" || m.kind === "severe");
  log(`${r.success ? "OK  " : "NG  "} ${label}`);
  for (const m of bad) log(`      ${m.id} ${m.text}`);
  return r.success;
};
const run = async (cmd, label = cmd) => show(await cn.run(cmd), label);

/** ソース行を QTMPSRC 経由でメンバーに入れる */
async function putSource(file, member, srcType, lines) {
  await cn.run(`DLTF FILE(${LIB}/QTMPSRC)`);
  if (!await run(`CRTSRCPF FILE(${LIB}/QTMPSRC) RCDLEN(112) MBR(QTMPSRC)`)) return false;
  const BATCH = 8; // 1 行ずつだと往復が多すぎて落ちる
  for (let i = 0; i < lines.length; i += BATCH) {
    const chunk = lines.slice(i, i + BATCH);
    const values = chunk
      .map((line, j) => `(${i + j + 1}.00,0,''${line.replace(/'/g, "''''")}'')`)
      .join(",");
    if (!await run(
      `RUNSQL SQL('INSERT INTO ${LIB}.QTMPSRC (SRCSEQ,SRCDAT,SRCDTA) VALUES ${values}') COMMIT(*NONE)`,
      `  行${i + 1}〜${i + chunk.length}`
    )) return false;
  }
  await cn.run(`CRTSRCPF FILE(${LIB}/${file}) RCDLEN(112)`);
  await cn.run(`RMVM FILE(${LIB}/${file}) MBR(${member})`);
  await cn.run(`ADDPFM FILE(${LIB}/${file}) MBR(${member}) SRCTYPE(${srcType})`);
  return await run(
    `CPYF FROMFILE(${LIB}/QTMPSRC) TOFILE(${LIB}/${file}) FROMMBR(QTMPSRC) TOMBR(${member}) MBROPT(*REPLACE) FMTOPT(*NOCHK)`,
    `  ${file}(${member}) へ複写`
  );
}

await cn.run(`CRTLIB LIB(${LIB})`);
await cn.run(`CRTDTAARA DTAARA(${LIB}/PCOMARK) TYPE(*CHAR) LEN(10) VALUE('INIT      ')`);
await cn.run(`CRTDTAARA DTAARA(${LIB}/PCOCMD) TYPE(*CHAR) LEN(123)`);
await cn.run(`CRTDTAARA DTAARA(${LIB}/PCOWAIT) TYPE(*CHAR) LEN(4) VALUE('*YES')`);
for (const old of ["PCOSEQ", "PCOLONG"]) await cn.run(`DLTPGM PGM(${LIB}/${old})`); // 旧構成の残骸
let failed = 0;
for (const p of PGMS) {
  log(`== ${p.name} (${p.src.length} 行) ==`);
  if (!await putSource("QCLSRC", p.name, "CLP", p.src)) { failed++; continue; }
  await cn.run(`DLTPGM PGM(${LIB}/${p.name})`);
  if (!await run(`CRTBNDCL PGM(${LIB}/${p.name}) SRCFILE(${LIB}/QCLSRC) SRCMBR(${p.name})`)) failed++;
}
cn.close();
log(failed === 0 ? "すべて作成できた" : `${failed} 本が作成できなかった`);
process.exit(failed === 0 ? 0 : 1);
