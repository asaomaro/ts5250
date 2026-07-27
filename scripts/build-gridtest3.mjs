// 実機に「窓枠・グリッド罫線の描き分け」を確かめるサンプル画面を作る。
//   TESTLIB/GRIDTST3 … 表示ファイル（記述は下の DDS 配列）
//   TESTLIB/GRIDCL3  … 画面1（罫線の種類ちがい ＋ 反転枠の窓）
//   TESTLIB/GRIDCL4  … 画面2（枠文字を指定した窓 ＋ 単独罫線の繰り返し）
// ソース投入は IFS/FTP 不要。RUNSQL で QTMPSRC に 1 行ずつ入れて CPYF で移す。
// 資格情報は環境変数からのみ受け取る（引数はプロセス一覧に見える）。
//   AS400_HOST=... AS400_USER=... AS400_PASSWORD=... node scripts/build-gridtest3.mjs
import { CommandConnection } from "@as400web/core";

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
/**
 * **機能欄は 45〜80 桁の 36 桁しかない。** はみ出すと桁がずれて別物として読まれる
 * （CPD8176 や CPD7494 が並ぶ）。空白で区切って 36 桁に収め、続きは `+` で送る。
 * 引用符でくくった値は途中で切らない——`+` は継続行の先頭の空白を捨てるので、
 * `'        '` のような空白だけの値が壊れる。
 */
const kwds = (t) => {
  const chunks = [];
  let rest = t;
  while (rest.length > 36) {
    // 折るのは**引用符の外にある空白**だけ。`+` は継続行の先頭の空白を捨てるので、
    // 語の途中や引用符の中で折ると値が壊れる（`'        '` が消える／`))` の前に
    // 空白が入って CPD8176「値が多すぎる」になる）
    let cut = -1;
    let quoted = false;
    for (let i = 0; i < rest.length && i <= 34; i++) {
      if (rest[i] === "'") quoted = !quoted;
      if (!quoted && rest[i] === " ") cut = i;
    }
    if (cut <= 0) break; // 折れないならそのまま出してコンパイラに判断させる
    chunks.push(rest.slice(0, cut) + " +");
    rest = rest.slice(cut + 1);
  }
  chunks.push(rest);
  return chunks.map(kwd);
};
const rec = (n, t = "") => put(put(put(put(blank(), 6, "A"), 17, "R"), 19, n), 45, t).replace(/ +$/, "");
const cons = (r, c, t) =>
  put(put(put(put(blank(), 6, "A"), 39, String(r).padStart(3)), 42, String(c).padStart(3)), 45, `'${t}'`).replace(/ +$/, "");

const DDS = [
  kwd("DSPSIZ(24 80 *DS3)"),
  rec("MAIN"),
  cons(1, 2, "GRIDTST3"),
  cons(2, 2, "Press Enter"),

  // 画面1: 線種ちがいの箱（実線・破線・点線）と、横罫だけ／縦罫だけの箱
  rec("GRD3", "GRDRCD"),
  ...kwds("GRDBOX((*POS (4 3 4 20)) (*TYPE PLAIN) (*COLOR RED) (*LINTYP SLD))"),
  ...kwds("GRDBOX((*POS (4 26 4 20)) (*TYPE PLAIN) (*COLOR YLW) (*LINTYP DSH))"),
  ...kwds("GRDBOX((*POS (4 49 4 20)) (*TYPE PLAIN) (*COLOR WHT) (*LINTYP DOT))"),
  ...kwds("GRDBOX((*POS (10 3 6 30)) (*TYPE HRZ 2) (*COLOR GRN))"),
  ...kwds("GRDBOX((*POS (10 40 6 30)) (*TYPE VRT 5) (*COLOR BLU))"),

  // 画面1 の窓: 枠を「反転表示の空白」で描く＝背景色のセルで枠を表す
  rec("WIN1", "WINDOW(18 20 4 36)"),
  ...kwds("WDWBORDER((*COLOR BLU) (*DSPATR RI) (*CHAR '        '))"),
  cons(2, 3, "REVERSE IMAGE BORDER"),

  // 画面2: 単独の罫線（上辺・左辺）を繰り返し付きで
  rec("GRD4", "GRDRCD"),
  ...kwds("GRDATR((*COLOR WHT) (*LINTYP SLD))"),
  ...kwds("GRDLIN((*POS (4 3 40)) (*TYPE UPPER 3 2))"),
  ...kwds("GRDLIN((*POS (14 3 8)) (*TYPE LEFT 4 6))"),

  // 画面2 の窓: 枠文字を明示指定＋見出し
  rec("WIN2", "WINDOW(16 20 5 40)"),
  ...kwds("WDWBORDER((*COLOR GRN) (*CHAR '+-+||+-+'))"),
  ...kwds("WDWTITLE((*TEXT 'CHAR BORDER') (*COLOR YLW))"),
  cons(2, 3, "EXPLICIT BORDER CHARS")
];

const CL3 = [
  "             PGM",
  `             DCLF       FILE(${LIB}/GRIDTST3) RCDFMT(MAIN GRD3 WIN1)`,
  "             SNDF       RCDFMT(MAIN)",
  "             SNDF       RCDFMT(GRD3)",
  "             SNDRCVF    RCDFMT(WIN1)",
  "             ENDPGM"
];
const CL4 = [
  "             PGM",
  `             DCLF       FILE(${LIB}/GRIDTST3) RCDFMT(MAIN GRD4 WIN2)`,
  "             SNDF       RCDFMT(MAIN)",
  "             SNDF       RCDFMT(GRD4)",
  "             SNDRCVF    RCDFMT(WIN2)",
  "             ENDPGM"
];

const host = process.env.AS400_HOST, user = process.env.AS400_USER, password = process.env.AS400_PASSWORD;
if (!host || !user || !password) { log("AS400_HOST / AS400_USER / AS400_PASSWORD を環境変数で"); process.exit(1); }
const cn = await CommandConnection.connect({ host, user, password, resolvePort: true });

const show = (r, label) => {
  const bad = r.messages.filter((m) => m.kind === "error" || m.kind === "severe");
  log(`${r.success ? "OK  " : "NG  "} ${label}`);
  for (const m of bad) log(`      ${m.id} ${m.text}`);
  return r.success;
};
const run = async (cmd, label = cmd) => show(await cn.run(cmd), label);

/** ソース行を QTMPSRC 経由でメンバーに入れる（RUNSQL は 1 行 = 1 リテラル） */
async function putSource(file, member, lines) {
  await cn.run(`DLTF FILE(${LIB}/QTMPSRC)`);
  if (!await run(`CRTSRCPF FILE(${LIB}/QTMPSRC) RCDLEN(112) MBR(QTMPSRC)`)) return false;
  let seq = 0;
  for (const line of lines) {
    seq += 1;
    // 引用符は 2 段でくくられる（CL の SQL(…) の中に SQL 文字列がある）ので 4 個に増やす
    const esc = line.replace(/'/g, "''''");
    const ok = await run(
      `RUNSQL SQL('INSERT INTO ${LIB}.QTMPSRC (SRCSEQ,SRCDAT,SRCDTA) VALUES (${seq}.00,0,''${esc}'')') COMMIT(*NONE)`,
      `  行${seq}: ${line.trim().slice(0, 48)}`
    );
    if (!ok) return false;
  }
  await cn.run(`CRTSRCPF FILE(${LIB}/${file}) RCDLEN(112)`); // 無ければ作る（あればエラーを捨てる）
  await cn.run(`RMVM FILE(${LIB}/${file}) MBR(${member})`);
  await cn.run(`ADDPFM FILE(${LIB}/${file}) MBR(${member}) SRCTYPE(${file === "QDDSSRC" ? "DSPF" : "CLP"})`);
  return await run(`CPYF FROMFILE(${LIB}/QTMPSRC) TOFILE(${LIB}/${file}) FROMMBR(QTMPSRC) TOMBR(${member}) MBROPT(*REPLACE) FMTOPT(*NOCHK)`, `  ${file}(${member}) へ複写`);
}

log("== DDS ==");
if (!await putSource("QDDSSRC", "GRIDTST3", DDS)) process.exit(1);
await cn.run(`DLTF FILE(${LIB}/GRIDTST3)`);
if (!await run(`CRTDSPF FILE(${LIB}/GRIDTST3) SRCFILE(${LIB}/QDDSSRC) SRCMBR(GRIDTST3)`)) {
  log("(コンパイル失敗。上のメッセージを見て DDS を直す)");
  process.exit(1);
}
for (const [mbr, src] of [["GRIDCL3", CL3], ["GRIDCL4", CL4]]) {
  log(`== ${mbr} ==`);
  if (!await putSource("QCLSRC", mbr, src)) process.exit(1);
  await cn.run(`DLTPGM PGM(${LIB}/${mbr})`);
  await run(`CRTBNDCL PGM(${LIB}/${mbr}) SRCFILE(${LIB}/QCLSRC) SRCMBR(${mbr})`);
}
cn.close();
log("完了");
