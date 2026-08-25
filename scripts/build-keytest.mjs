// 実機に「AID キーごとの欄データの扱い」と「カーソル送り（FLDCSRPRG）」を見る画面を作る。
//   <LIB>/KEYDSPF … 表示ファイル
//   <LIB>/KEYPGM  … RPG（押されたキーと、**ホストが受け取った欄の値**を返す）
//
// **何を見るための画面か。**
//   ④ `CA` キー（コマンド・アテンション）は**欄データを送らない**——どのキーがそれかは
//      SOH オーダー（0x01）のヘッダの 24 ビットで届く。当方は SOH を読み捨てていたので、
//      F12 で欄データを送ってしまい「取り消したのに反映される」形になる。
//      対照に `CF`（コマンド・ファンクション）キーを 1 つ置く（こちらは送る）。
//   ⑤ `FLDCSRPRG`（カーソル送り）は「この欄を出たら次はこの欄へ」をホストが指定する。
//      ワイヤ上は FCW `0x88nn`（nn = 送り先の欄番号）。当方は読み飛ばしていた。
//
// ソース投入は IFS/FTP 不要。RUNSQL で QTMPSRC に入れて CPYF で移す（build-audpgm.mjs と同方式）。
//   node --env-file=.env --env-file=.env.verify scripts/build-keytest.mjs
// 実機での使い方:
//   CALL <LIB>/KEYPGM     （F3 で終了）
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
const fld = (name, len, type, dec, use, r, c) => {
  let s = put(blank(), 6, "A");
  s = put(s, 19, name);
  s = put(s, 30, String(len).padStart(5));
  s = put(s, 35, type);
  if (dec !== "") s = put(s, 36, String(dec).padStart(2));
  s = put(s, 38, use);
  s = put(s, 39, String(r).padStart(3));
  s = put(s, 42, String(c).padStart(3));
  return s.replace(/ +$/, "");
};

const DDS = [
  kwd("DSPSIZ(24 80 *DS3)"),
  rec("KEYR"),
  kwd("CA03(03)"), // 終了（CA＝欄データを送らない）
  kwd("CA12(12)"), // ④の主役。CA なので欄データは届かないはず
  kwd("CF06(06)"), // 対照。CF なので欄データは届く
  cons(1, 2, "KEYPGM AID/CURSOR TEST"),
  cons(3, 2, "IN1 (PRG TO IN3)"),
  fld("IN1", 5, "A", "", "B", 3, 30),
  kwd("FLDCSRPRG(IN3)"), // ⑤ カーソル送り: IN1 を出たら IN2 ではなく IN3 へ
  cons(5, 2, "IN2"),
  fld("IN2", 5, "A", "", "B", 5, 30),
  cons(7, 2, "IN3"),
  fld("IN3", 5, "A", "", "B", 7, 30),
  cons(10, 2, "HOST RECEIVED"),
  cons(11, 2, "KEY"),
  fld("EKEY", 5, "A", "", "O", 11, 30),
  cons(13, 2, "IN1"),
  fld("EIN1", 5, "A", "", "O", 13, 30),
  cons(15, 2, "IN2"),
  fld("EIN2", 5, "A", "", "O", 15, 30),
  cons(17, 2, "IN3"),
  fld("EIN3", 5, "A", "", "O", 17, 30),
  cons(22, 2, "ENTER F6=CF F12=CA F3=EXIT")
];

// **受け取った値をそのまま返す**。CA キーでは欄データが届かないので、前回の値が残る。
const RPG = [
  "**free",
  `dcl-f KEYDSPF workstn extdesc('${LIB}/KEYDSPF') extfile(*extdesc);`,
  "dou *in03;",
  "  exfmt KEYR;",
  "  if *in12;",
  "    EKEY = 'F12';",
  "  elseif *in06;",
  "    EKEY = 'F06';",
  "  else;",
  "    EKEY = 'ENT';",
  "  endif;",
  "  EIN1 = IN1;",
  "  EIN2 = IN2;",
  "  EIN3 = IN3;",
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

log("== DDS（KEYDSPF: CA/CF キー ＋ FLDCSRPRG）==");
if (!await putSource("QDDSSRC", "KEYDSPF", "DSPF", DDS)) process.exit(1);
await cn.run(`DLTF FILE(${LIB}/KEYDSPF)`);
if (!await run(`CRTDSPF FILE(${LIB}/KEYDSPF) SRCFILE(${LIB}/QDDSSRC) SRCMBR(KEYDSPF)`)) {
  log("(コンパイル失敗。上のメッセージを見て DDS を直す)");
  process.exit(1);
}

log("== RPG（KEYPGM）==");
if (!await putSource("QRPGLESRC", "KEYPGM", "RPGLE", RPG)) process.exit(1);
await cn.run(`DLTPGM PGM(${LIB}/KEYPGM)`);
if (!await run(`CRTBNDRPG PGM(${LIB}/KEYPGM) SRCFILE(${LIB}/QRPGLESRC) SRCMBR(KEYPGM) DFTACTGRP(*NO)`)) process.exit(1);

cn.close();
log(`完了。実機では  CALL ${LIB}/KEYPGM  （F3 で終了）`);
