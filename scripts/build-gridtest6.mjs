// 実機に「罫線を描いた直後に CLEAR UNIT が来る」画面を作る（S9R167D の再現）。
//   <LIB>/GRIDTST6 … 表示ファイル（記述は下の DDS 配列）
//   <LIB>/GRIDCL8  … 罫線レコード → **OVERLAY を付けない**レコードの順に送る（＝素の CLEAR UNIT が来る）
//   <LIB>/GRIDCL9  … 同じ罫線レコード → **OVERLAY 付き**レコード（対照。CLEAR UNIT は来ない）
//
// **なぜ 24x80 専用（*DS3）か。** 症状が出た S9R167D は `DSPSIZ(24 80 *DS3)` で、
// alternate（27x132）を申告していない画面だった。alternate を申告した画面（YB0270R）向けの
// 修正（CLEAR UNIT ALTERNATE で GUI を消さない）は素通りする。
//
// ソース投入は IFS/FTP 不要。RUNSQL で QTMPSRC に入れて CPYF で移す（build-gridtest3.mjs と同方式）。
// 資格情報は環境変数からのみ受け取る（引数はプロセス一覧に見える）。
//   node --env-file=.env --env-file=.env.verify scripts/build-gridtest6.mjs
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
/** 機能欄は 36 桁しかない。空白（引用符の外）で折って `+` で続ける（build-gridtest3.mjs と同じ） */
const kwds = (t) => {
  const chunks = [];
  let rest = t;
  while (rest.length > 36) {
    let cut = -1;
    let quoted = false;
    for (let i = 0; i < rest.length && i <= 34; i++) {
      if (rest[i] === "'") quoted = !quoted;
      if (!quoted && rest[i] === " ") cut = i;
    }
    if (cut <= 0) break;
    chunks.push(rest.slice(0, cut) + " +");
    rest = rest.slice(cut + 1);
  }
  chunks.push(rest);
  return chunks.map(kwd);
};
const rec = (n, t = "") => put(put(put(put(blank(), 6, "A"), 17, "R"), 19, n), 45, t).replace(/ +$/, "");
/**
 * 定数（位置指定つき）。**機能欄は 45〜80 桁の 36 桁しかない**ので、引用符込みで収まる長さ
 * （34 文字）までに限る。はみ出すと DDS は 80 桁で切って続きを別物として読み、
 * CPD7508（引用符が閉じていない）＋ CPD7596（定数に位置が無い）が並ぶ——実際に踏んだ。
 */
const cons = (r, c, t) => {
  if (t.length > 34) throw new Error(`定数が長すぎる（${t.length} 文字。34 まで）: ${t}`);
  return put(put(put(put(blank(), 6, "A"), 39, String(r).padStart(3)), 42, String(c).padStart(3)), 45, `'${t}'`).replace(/ +$/, "");
};

/**
 * 罫線 13 本（KSN20 と同じ「表を罫線で組む」使い方）。
 * 縦（*TYPE LEFT）はその桁の左に高さぶん、横（*TYPE UPPER）はその行の上に長さぶん引かれる。
 * **本数を実機の KSN20 に揃えてある**——「1 本残った」ではなく「全部出ているか」を数で見たいため。
 */
const GRID_LINES = [
  "GRDLIN((*POS (4 2 76)) (*TYPE UPPER))",
  "GRDLIN((*POS (6 2 76)) (*TYPE UPPER))",
  "GRDLIN((*POS (12 2 76)) (*TYPE UPPER))",
  "GRDLIN((*POS (20 2 76)) (*TYPE UPPER))",
  "GRDLIN((*POS (4 2 16)) (*TYPE LEFT))",
  "GRDLIN((*POS (4 12 16)) (*TYPE LEFT))",
  "GRDLIN((*POS (4 22 16)) (*TYPE LEFT))",
  "GRDLIN((*POS (4 32 16)) (*TYPE LEFT))",
  "GRDLIN((*POS (4 42 16)) (*TYPE LEFT))",
  "GRDLIN((*POS (4 52 16)) (*TYPE LEFT))",
  "GRDLIN((*POS (4 62 16)) (*TYPE LEFT))",
  "GRDLIN((*POS (4 72 16)) (*TYPE LEFT))",
  "GRDLIN((*POS (4 78 16)) (*TYPE LEFT))"
];

const DDS = [
  kwd("DSPSIZ(24 80 *DS3)"), // ★ alternate 未申告（S9R167D と同じ）
  // 罫線だけのレコード。ホストは WDSF（Draw Grid Lines 0x60）で送ってくる
  rec("GRDLNS", "GRDRCD"),
  ...kwds("GRDATR((*COLOR WHT) (*LINTYP SLD))"),
  ...GRID_LINES.flatMap((l) => kwds(l)),

  // **OVERLAY を付けない**本文レコード。罫線の直後に書くと、ホストは画面を消すために
  // 素の CLEAR UNIT（ESC 0x40）を罫線の**後ろ**に置いて送ってくる＝症状の再現。
  rec("MAIN"),
  cons(1, 2, "GRIDTST6 GRID LINES + CLEAR UNIT"),
  cons(2, 2, "NO OVERLAY - 13 LINES MUST SHOW"),
  cons(5, 4, "COL-A"),
  cons(5, 14, "COL-B"),
  cons(5, 24, "COL-C"),
  cons(5, 34, "COL-D"),
  cons(7, 4, "ROW-1"),
  cons(13, 4, "ROW-2"),
  cons(22, 2, "PRESS ENTER TO END"),

  // 対照: OVERLAY 付き（CLEAR UNIT は来ない。修正前でも罫線は残る）
  rec("MAINOV", "OVERLAY"),
  cons(1, 2, "GRIDTST6 GRID LINES + OVERLAY"),
  cons(2, 2, "CONTROL - 13 LINES MUST SHOW"),
  cons(22, 2, "PRESS ENTER TO END")
];

const CL8 = [
  "             PGM",
  `             DCLF       FILE(${LIB}/GRIDTST6) RCDFMT(GRDLNS MAIN)`,
  "             SNDF       RCDFMT(GRDLNS)",
  "             SNDRCVF    RCDFMT(MAIN)",
  "             ENDPGM"
];
const CL9 = [
  "             PGM",
  `             DCLF       FILE(${LIB}/GRIDTST6) RCDFMT(GRDLNS MAINOV)`,
  "             SNDF       RCDFMT(GRDLNS)",
  "             SNDRCVF    RCDFMT(MAINOV)",
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
 *
 * **先に桁あふれを見る。** RCDLEN(112) のソース物理ファイルの SRCDTA は 100 桁で、
 * 超えると SQL0404（値が長すぎる）で INSERT が落ちる——長い定数を 45 桁目から置くと簡単に届く。
 * ホストのエラーだけ見ても「どの行か」が分からないので、送る前に行番号ごと落とす。
 */
async function putSource(file, member, lines) {
  const tooLong = lines.map((l, i) => [i + 1, l]).filter(([, l]) => l.length > 100);
  if (tooLong.length) {
    for (const [n, l] of tooLong) log(`NG  ${file}(${member}) 行${n} が ${l.length} 桁（SRCDTA は 100 桁まで）: ${l.trim()}`);
    return false;
  }
  await cn.run(`DLTF FILE(${LIB}/QTMPSRC)`);
  if (!await run(`CRTSRCPF FILE(${LIB}/QTMPSRC) RCDLEN(112) MBR(QTMPSRC)`)) return false;
  // 1 行ずつ INSERT すると往復が多すぎて途中で落ちるので、まとめて送る
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

log("== DDS（GRIDTST6: 罫線 13 本 ＋ OVERLAY 無しの本文）==");
if (!await putSource("QDDSSRC", "GRIDTST6", DDS)) process.exit(1);
await cn.run(`DLTF FILE(${LIB}/GRIDTST6)`);
if (!await run(`CRTDSPF FILE(${LIB}/GRIDTST6) SRCFILE(${LIB}/QDDSSRC) SRCMBR(GRIDTST6)`)) {
  log("(コンパイル失敗。上のメッセージを見て DDS を直す)");
  process.exit(1);
}

for (const [mbr, src] of [["GRIDCL8", CL8], ["GRIDCL9", CL9]]) {
  log(`== ${mbr} ==`);
  if (!await putSource("QCLSRC", mbr, src)) process.exit(1);
  await cn.run(`DLTPGM PGM(${LIB}/${mbr})`);
  if (!await run(`CRTBNDCL PGM(${LIB}/${mbr}) SRCFILE(${LIB}/QCLSRC) SRCMBR(${mbr})`)) process.exit(1);
}
cn.close();
log("完了");
