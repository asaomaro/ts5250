// 実機に「外字（UDC）を含む DBCS 欄を編集して送り返す」画面を作る。
//   <LIB>/UDCDSPF … 表示ファイル（`O`＝DBCS open の入力欄 1 つ ＋ 結果表示）
//   <LIB>/UDCPGM  … RPG（外字 1 文字を表示し、**送り返された値が期待どおりか**を判定する）
//
// **何を見るための画面か。** CCSID 930 の外字（0x6941〜）は Unicode の私用面 U+E000〜へ落ちる。
// ts5250 は「表示できないバイト・埋め込み属性」を運ぶセンチネルにも私用面 U+E000+byte を
// 使っており、**U+E000〜U+E0FF がまるごと衝突していた**——外字を含む欄を編集して送ると、
// 外字 1 文字が生バイト 1 つ（例 0x00）に化けて SO/SI ごと消える。
//
// 画面は外字 1 文字（`x'0E69410F'`＝SO + 6941 + SI）を欄に出す。端末側でその後ろに `AB` を
// 打って Enter を押すと、ホストは `x'0E69410FC1C2'` を受け取るはず。
//   SAME … 期待どおり（外字が保たれた）
//   DIFF … 別の値が届いた（＝壊れている）
//   NONE … 送り返されなかった（MDT が立っていない）
//
//   node --env-file=.env --env-file=.env.verify scripts/build-udctest.mjs
// 実機での使い方:
//   CALL <LIB>/UDCPGM     （F3 で終了）
//
// ⚠ 外字の**字形**はホストの外字フォントの話で、ブラウザでは字形は出ない（豆腐になる）。
//    ここで見ているのは**バイトの identity が保たれるか**だけ。
import { CommandConnection } from "@ts5250/hostserver";

const LIB = process.env.AS400_LIB ?? "TESTLIB";
const log = (s) => process.stdout.write(s + "\n");

const put = (base, pos, str) => {
  const a = base.split("");
  for (let i = 0; i < str.length; i++) a[pos - 1 + i] = str[i];
  return a.join("");
};
const blank = () => " ".repeat(80);
const kwd = (t) => put(put(blank(), 6, "A"), 45, t).replace(/ +$/, "");
const rec = (n) => put(put(put(blank(), 6, "A"), 17, "R"), 19, n).replace(/ +$/, "");
const cons = (r, c, t) => {
  if (t.length > 34) throw new Error(`定数が長すぎる（${t.length} 文字。34 まで）: ${t}`);
  return put(put(put(put(blank(), 6, "A"), 39, String(r).padStart(3)), 42, String(c).padStart(3)), 45, `'${t}'`).replace(/ +$/, "");
};
const fld = (name, len, type, use, r, c) => {
  let s = put(blank(), 6, "A");
  s = put(s, 19, name);
  s = put(s, 30, String(len).padStart(5));
  s = put(s, 35, type);
  s = put(s, 38, use);
  s = put(s, 39, String(r).padStart(3));
  s = put(s, 42, String(c).padStart(3));
  return s.replace(/ +$/, "");
};

const DDS = [
  kwd("DSPSIZ(24 80 *DS3)"),
  rec("UDCR"),
  kwd("CA03(03)"),
  cons(1, 2, "UDC ROUND TRIP TEST"),
  cons(3, 2, "IN1 (DBCS OPEN)"),
  fld("IN1", 10, "O", "B", 3, 30),
  cons(5, 2, "RESULT"),
  fld("EOK", 4, "A", "O", 5, 30),
  cons(7, 2, "ECHO"),
  fld("EIN1", 10, "O", "O", 7, 30),
  // **DBCS 種別を申告していない欄（`A`）に DBCS データが入っている場合。**
  // 日本語機では珍しくない（SO/SI 込みのバイトをそのまま持つ char 欄）。
  // `DSPATR(MDT)` を付けて**打鍵せずに送り返させる**——端末が保持している値がそのまま届く。
  cons(9, 2, "IN2 (SBCS DECL + DBCS)"),
  fld("IN2", 10, "A", "B", 9, 30),
  kwd("DSPATR(MDT)"),
  cons(11, 2, "RESULT2"),
  fld("EOK2", 4, "A", "O", 11, 30),
  cons(20, 2, "TYPE AB AT THE END"),
  cons(22, 2, "ENTER=SEND  F3=EXIT")
];

// `x'0E69410F'` … SO + 外字(0x6941) + SI / `C1C2` … "AB"
const RPG = [
  "**free",
  `dcl-f UDCDSPF workstn extdesc('${LIB}/UDCDSPF') extfile(*extdesc);`,
  "dcl-s shown char(10);",
  "dcl-s want char(10);",
  "dcl-s shown2 char(10);",
  "shown = x'0E69410F';",
  "want = x'0E69410FC1C2';",
  // SO + 「設通」（0x4481 0x4482）+ SI。申告なしの char 欄へそのまま置く
  "shown2 = x'0E448144820F';",
  "dou *in03;",
  "  IN1 = shown;",
  "  IN2 = shown2;",
  "  exfmt UDCR;",
  "  if IN1 = want;",
  "    EOK = 'SAME';",
  "  elseif IN1 = shown;",
  "    EOK = 'NONE';",
  "  else;",
  "    EOK = 'DIFF';",
  "  endif;",
  "  EIN1 = IN1;",
  "  if IN2 = shown2;",
  "    EOK2 = 'SAME';",
  "  else;",
  "    EOK2 = 'DIFF';",
  "  endif;",
  "enddo;",
  "*inlr = *on;",
  "return;"
];

const host = process.env.AS400_HOST, user = process.env.AS400_USER, password = process.env.AS400_PASSWORD;
if (!host || !user || !password) { log("AS400_HOST / AS400_USER / AS400_PASSWORD を環境変数で"); process.exit(1); }
const connect = async () => {
  for (let a = 1; ; a++) {
    try {
      return await CommandConnection.connect({ host, user, password, resolvePort: true, timeoutMs: 40_000 });
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

async function putSource(file, member, srcType, lines) {
  const tooLong = lines.map((l, i) => [i + 1, l]).filter(([, l]) => l.length > 100);
  if (tooLong.length) {
    for (const [n, l] of tooLong) log(`NG  ${file}(${member}) 行${n} が ${l.length} 桁（SRCDTA は 100 桁まで）`);
    return false;
  }
  await cn.run(`DLTF FILE(${LIB}/QTMPSRC)`);
  if (!await run(`CRTSRCPF FILE(${LIB}/QTMPSRC) RCDLEN(112) MBR(QTMPSRC)`)) return false;
  const BATCH = 8;
  for (let i = 0; i < lines.length; i += BATCH) {
    const chunk = lines.slice(i, i + BATCH);
    const values = chunk.map((line, j) => `(${i + j + 1}.00,0,''${line.replace(/'/g, "''''")}'')`).join(",");
    const ok = await run(
      `RUNSQL SQL('INSERT INTO ${LIB}.QTMPSRC (SRCSEQ,SRCDAT,SRCDTA) VALUES ${values}') COMMIT(*NONE) DECMPT(*PERIOD)`,
      `  行${i + 1}〜${i + chunk.length}`
    );
    if (!ok) return false;
  }
  await cn.run(`CRTSRCPF FILE(${LIB}/${file}) RCDLEN(112)`);
  await cn.run(`RMVM FILE(${LIB}/${file}) MBR(${member})`);
  await cn.run(`ADDPFM FILE(${LIB}/${file}) MBR(${member}) SRCTYPE(${srcType})`);
  return await run(
    `CPYF FROMFILE(${LIB}/QTMPSRC) TOFILE(${LIB}/${file}) FROMMBR(QTMPSRC) TOMBR(${member}) MBROPT(*REPLACE) FMTOPT(*NOCHK)`,
    `  ${file}(${member}) へ複写`
  );
}

log("== DDS（UDCDSPF: DBCS open の入力欄）==");
if (!await putSource("QDDSSRC", "UDCDSPF", "DSPF", DDS)) process.exit(1);
await cn.run(`DLTF FILE(${LIB}/UDCDSPF)`);
// **IGCDTA(*YES)**: DBCS の欄を持つ表示ファイルはこれが要る（既定 *NO だと CPD…で落ちる）
if (!await run(`CRTDSPF FILE(${LIB}/UDCDSPF) SRCFILE(${LIB}/QDDSSRC) SRCMBR(UDCDSPF) IGCDTA(*YES)`)) {
  log("(コンパイル失敗。上のメッセージを見て DDS を直す)");
  process.exit(1);
}

log("== RPG（UDCPGM）==");
if (!await putSource("QRPGLESRC", "UDCPGM", "RPGLE", RPG)) process.exit(1);
await cn.run(`DLTPGM PGM(${LIB}/UDCPGM)`);
if (!await run(`CRTBNDRPG PGM(${LIB}/UDCPGM) SRCFILE(${LIB}/QRPGLESRC) SRCMBR(UDCPGM) DFTACTGRP(*NO)`)) process.exit(1);

cn.close();
log(`完了。実機では  CALL ${LIB}/UDCPGM  （F3 で終了）`);
