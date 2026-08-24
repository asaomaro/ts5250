// 実機に「反転（背景色）が縦に連続する」画面を作る。
//   <LIB>/REVTST … 表示ファイル（記述は下の DDS 配列）
//   <LIB>/REVCL  … それを表示する CL
//
// **何を見るための画面か。** 行間（line-height の余白）は文字要素の背景では塗られないので、
// 反転が縦に続くと行と行の間に地色が横線として並ぶ（ACS は隙間なく繋がって見える）。
// 症状はサインオン splash のロゴのような**複数行の反転**でしか出ないため、
// 実機に同じ形——空白だけの反転を縦に 8 行——を用意する。
// 隣接する別色の反転（下の 3 行）は、埋めた分がはみ出して混色しないかを見るため。
//
// **空白だけの定数にしてある**のは実画素で測るため。文字があるとその画素は反転の文字色
// （＝地色と同じ値）になり、隙間と見分けが付かない。
//
// ソース投入は IFS/FTP 不要。RUNSQL で QTMPSRC に入れて CPYF で移す（build-gridtest3.mjs と同方式）。
// 資格情報は環境変数からのみ受け取る（引数はプロセス一覧に見える）。
//   node --env-file=.env --env-file=.env.verify scripts/build-revtest.mjs
import { CommandConnection } from "@ts5250/hostserver";

const LIB = process.env.AS400_LIB ?? "TESTLIB";
const log = (s) => process.stdout.write(s + "\n");

// --- DDS を桁位置で組み立てる（機能欄は 45〜80 桁）---
const put = (base, pos, str) => {
  const a = base.split("");
  for (let i = 0; i < str.length; i++) a[pos - 1 + i] = str[i];
  return a.join("");
};
const blank = () => " ".repeat(80);
const kwd = (t) => put(put(blank(), 6, "A"), 45, t).replace(/ +$/, "");
const rec = (n, t = "") => put(put(put(put(blank(), 6, "A"), 17, "R"), 19, n), 45, t).replace(/ +$/, "");
/**
 * 定数（位置指定つき）。**機能欄は 45〜80 桁の 36 桁**しかないので引用符込み 34 文字まで。
 * はみ出すと 80 桁で切られ、続きが別物として読まれる（CPD7508＋CPD7596）。
 */
const cons = (r, c, t) => {
  if (t.length > 34) throw new Error(`定数が長すぎる（${t.length} 文字。34 まで）: ${t}`);
  // **末尾の空白を落とさない**——この画面は空白だけの定数が主役
  return put(put(put(put(blank(), 6, "A"), 39, String(r).padStart(3)), 42, String(c).padStart(3)), 45, `'${t}'`);
};

const WIDTH = 24; // 反転させる桁数
const BLOCK_TOP = 6; // 白（既定色）の反転が続く先頭行
const BLOCK_ROWS = 8;
const RED_TOP = 16; // 隣接する別色の反転
const RED_ROWS = 3;
const COL = 20;

/** 空白だけの反転行（`DSPATR(RI)` は定数の次の行に置く＝直前の定数に掛かる） */
const reverseRow = (row, color) => [
  cons(row, COL, " ".repeat(WIDTH)),
  ...(color ? [kwd(`COLOR(${color})`)] : []),
  kwd("DSPATR(RI)")
];

const DDS = [
  kwd("DSPSIZ(24 80 *DS3)"),
  rec("MAIN"),
  cons(1, 2, "REVTST  REVERSE ROWS"),
  cons(3, 2, "BLOCKS MUST HAVE NO GAPS"),
  ...Array.from({ length: BLOCK_ROWS }, (_, i) => reverseRow(BLOCK_TOP + i)).flat(),
  cons(14, 2, "SAME BLOCK IN ANOTHER COLOR"),
  ...Array.from({ length: RED_ROWS }, (_, i) => reverseRow(RED_TOP + i, "RED")).flat(),
  cons(22, 2, "PRESS ENTER TO END")
];

const CL = [
  "             PGM",
  `             DCLF       FILE(${LIB}/REVTST) RCDFMT(MAIN)`,
  "             SNDRCVF    RCDFMT(MAIN)",
  "             ENDPGM"
];

const host = process.env.AS400_HOST, user = process.env.AS400_USER, password = process.env.AS400_PASSWORD;
if (!host || !user || !password) { log("AS400_HOST / AS400_USER / AS400_PASSWORD を環境変数で"); process.exit(1); }
// 実機がたまに応答を返さないので、接続だけは少し粘る
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

/**
 * ソース行を QTMPSRC 経由でメンバーに入れる（RUNSQL は 1 行 = 1 リテラル）。
 * **先に桁あふれを見る**——RCDLEN(112) の SRCDTA は 100 桁で、超えると SQL0404 で落ちる。
 */
async function putSource(file, member, lines) {
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
    // 引用符は 2 段でくくられる（CL の SQL(…) の中に SQL 文字列がある）ので 4 個に増やす
    const values = chunk
      .map((line, j) => `(${i + j + 1}.00,0,''${line.replace(/'/g, "''''")}'')`)
      .join(",");
    const ok = await run(
      `RUNSQL SQL('INSERT INTO ${LIB}.QTMPSRC (SRCSEQ,SRCDAT,SRCDTA) VALUES ${values}') COMMIT(*NONE)`,
      `  行${i + 1}〜${i + chunk.length}`
    );
    if (!ok) return false;
  }
  await cn.run(`CRTSRCPF FILE(${LIB}/${file}) RCDLEN(112)`); // 無ければ作る（あればエラーを捨てる）
  await cn.run(`RMVM FILE(${LIB}/${file}) MBR(${member})`);
  await cn.run(`ADDPFM FILE(${LIB}/${file}) MBR(${member}) SRCTYPE(${file === "QDDSSRC" ? "DSPF" : "CLP"})`);
  return await run(`CPYF FROMFILE(${LIB}/QTMPSRC) TOFILE(${LIB}/${file}) FROMMBR(QTMPSRC) TOMBR(${member}) MBROPT(*REPLACE) FMTOPT(*NOCHK)`, `  ${file}(${member}) へ複写`);
}

log("== DDS（REVTST: 反転の連続）==");
if (!await putSource("QDDSSRC", "REVTST", DDS)) process.exit(1);
await cn.run(`DLTF FILE(${LIB}/REVTST)`);
if (!await run(`CRTDSPF FILE(${LIB}/REVTST) SRCFILE(${LIB}/QDDSSRC) SRCMBR(REVTST)`)) {
  log("(コンパイル失敗。上のメッセージを見て DDS を直す)");
  process.exit(1);
}

log("== REVCL ==");
if (!await putSource("QCLSRC", "REVCL", CL)) process.exit(1);
await cn.run(`DLTPGM PGM(${LIB}/REVCL)`);
if (!await run(`CRTBNDCL PGM(${LIB}/REVCL) SRCFILE(${LIB}/QCLSRC) SRCMBR(REVCL)`)) process.exit(1);

cn.close();
log("完了");
