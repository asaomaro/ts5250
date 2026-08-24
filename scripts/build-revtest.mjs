// 実機に「反転（背景色）が縦に連続する」画面を作る。
//   <LIB>/REVTST … 表示ファイル（記述は下の DDS 配列。画面は 2 つ）
//   <LIB>/REVCL  … 画面1（同じ幅の帯を縦に重ねる＝行間の隙間を見る）
//   <LIB>/REVCL2 … 画面2（**幅の違う帯**を交互に重ねる＝上下へのはみ出しを見る）
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
// **画面2（幅違い）の狙い。** 隙間を埋める処置は「背景を上下へ延ばす」形なので、延ばしすぎると
// 逆に**隣の行へ被さる**。同じ幅の帯を重ねただけでは、被さった先も同じ色なので見えない——
// そこで幅を交互に変え、**広い帯だけがはみ出す桁**を作る。そこには上下の行の地色しか無いので、
// 塗った高さをそのまま測れる。加えて広い帯の**すぐ上と下の行に文字**を置き、
// 同じ文字を帯の外の桁にも並べる（対照）。被れば内側の文字だけ画素が減る。
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

// --- 画面2（幅違いの帯）のレイアウト。**検証スクリプトと数値を合わせること** ---
const WIDE = 32; // 広い帯の桁数（定数は引用符込み 34 文字までなので、これが上限）
const NARROW = 12; // 狭い帯の桁数
const BAND_TOP = 6; // 広い帯の先頭行（以降 広・狭 と交互）
const BAND_PAIRS = 3; // 広狭の組の数（最後にもう 1 本広い帯を置くので 広は 4 本）
const TEXT_IN = 34; // 帯の中に入る桁（広い帯だけが届く範囲）に置く文字
const TEXT_OUT = 60; // 帯の外（対照）に置く同じ文字
const TEXT = "XXXXXXXXXXXX";
/**
 * **上下の行の文字は帯と別の色にする。** 既定色（緑）のままだと帯の色と同じになり、
 * 「帯が被った画素」と「文字の画素」を色で見分けられない——実画素で測る側が困る。
 * 帯の色（下）と重ならない色を選ぶこと。
 */
const TEXT_COLOR = "TRQ";
/**
 * **帯は 1 本ずつ色を変える。** 同じ色で重ねると、はみ出して隣の行に被っても
 * 被った先が同じ色なので**目にも実画素にも出ない**。隣り合う帯を別の色にすれば、
 * はみ出しは「隣の行に違う色が乗る」形で出る（DDS リファレンス Table 15 の色名）。
 * 上下の文字（TRQ）と、そのすぐ隣に来る帯（1 本目・最後）は別の色にしてある。
 */
const BAND_COLORS = ["GRN", "WHT", "PNK", "YLW", "BLU", "GRN", "RED"];

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

/** 幅と色を指定した反転行（画面2 用） */
const bandRow = (row, width, color) => [
  cons(row, COL, " ".repeat(width)),
  kwd(`COLOR(${color})`),
  kwd("DSPATR(RI)")
];

/**
 * 画面2 の行の並び: 広・狭 を交互に置き、最後にもう 1 本広い帯を置く。
 * **広い帯の上下は必ず「狭い帯か文字の行」**になるので、広い帯だけが届く桁
 * （COL+NARROW 〜 COL+WIDE）では、上下に地色しか無い状態で塗った高さを測れる。
 */
const BAND_ROWS = [
  ...Array.from({ length: BAND_PAIRS }, (_, i) => [
    bandRow(BAND_TOP + i * 2, WIDE, BAND_COLORS[i * 2]),
    bandRow(BAND_TOP + i * 2 + 1, NARROW, BAND_COLORS[i * 2 + 1])
  ]).flat(),
  bandRow(BAND_TOP + BAND_PAIRS * 2, WIDE, BAND_COLORS[BAND_PAIRS * 2])
];
const BAND_LAST = BAND_TOP + BAND_PAIRS * 2; // 最後の広い帯の行

const DDS2 = [
  rec("MAIN2"),
  cons(1, 2, "REVTST2 BAND WIDTHS"),
  cons(3, 2, "WIDE/NARROW COLORED - NO BLEED"),
  // 広い帯の**すぐ上**の行。帯の中（TEXT_IN）と外（TEXT_OUT）に同じ文字を置いて見比べる
  cons(BAND_TOP - 1, TEXT_IN, TEXT),
  kwd(`COLOR(${TEXT_COLOR})`),
  cons(BAND_TOP - 1, TEXT_OUT, TEXT),
  kwd(`COLOR(${TEXT_COLOR})`),
  ...BAND_ROWS.flat(),
  // 広い帯の**すぐ下**の行
  cons(BAND_LAST + 1, TEXT_IN, TEXT),
  kwd(`COLOR(${TEXT_COLOR})`),
  cons(BAND_LAST + 1, TEXT_OUT, TEXT),
  kwd(`COLOR(${TEXT_COLOR})`),
  cons(22, 2, "PRESS ENTER TO END")
];

const CL = [
  "             PGM",
  `             DCLF       FILE(${LIB}/REVTST) RCDFMT(MAIN)`,
  "             SNDRCVF    RCDFMT(MAIN)",
  "             ENDPGM"
];
const CL2 = [
  "             PGM",
  `             DCLF       FILE(${LIB}/REVTST) RCDFMT(MAIN2)`,
  "             SNDRCVF    RCDFMT(MAIN2)",
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
      // **小数点をジョブ任せにしない**——`RUNSQL` の `DECMPT` 既定は `*JOB` で、
      // pub400 は `QDECFMT=J`（小数点がカンマ）。`(1.00,0,…)` は SQL0104、
      // `(2,0,…)` は `2,0` が 1 個の数と読まれて SQL0117 になる（pub400 で実測）。
      `RUNSQL SQL('INSERT INTO ${LIB}.QTMPSRC (SRCSEQ,SRCDAT,SRCDTA) VALUES ${values}') COMMIT(*NONE) DECMPT(*PERIOD)`,
      `  行${i + 1}〜${i + chunk.length}`
    );
    if (!ok) return false;
  }
  await cn.run(`CRTSRCPF FILE(${LIB}/${file}) RCDLEN(112)`); // 無ければ作る（あればエラーを捨てる）
  await cn.run(`RMVM FILE(${LIB}/${file}) MBR(${member})`);
  await cn.run(`ADDPFM FILE(${LIB}/${file}) MBR(${member}) SRCTYPE(${file === "QDDSSRC" ? "DSPF" : "CLP"})`);
  return await run(`CPYF FROMFILE(${LIB}/QTMPSRC) TOFILE(${LIB}/${file}) FROMMBR(QTMPSRC) TOMBR(${member}) MBROPT(*REPLACE) FMTOPT(*NOCHK)`, `  ${file}(${member}) へ複写`);
}

log("== DDS（REVTST: 反転の連続 ＋ 幅違いの帯）==");
if (!await putSource("QDDSSRC", "REVTST", [...DDS, ...DDS2])) process.exit(1);
await cn.run(`DLTF FILE(${LIB}/REVTST)`);
if (!await run(`CRTDSPF FILE(${LIB}/REVTST) SRCFILE(${LIB}/QDDSSRC) SRCMBR(REVTST)`)) {
  log("(コンパイル失敗。上のメッセージを見て DDS を直す)");
  process.exit(1);
}

for (const [mbr, src] of [["REVCL", CL], ["REVCL2", CL2]]) {
  log(`== ${mbr} ==`);
  if (!await putSource("QCLSRC", mbr, src)) process.exit(1);
  await cn.run(`DLTPGM PGM(${LIB}/${mbr})`);
  if (!await run(`CRTBNDCL PGM(${LIB}/${mbr}) SRCFILE(${LIB}/QCLSRC) SRCMBR(${mbr})`)) process.exit(1);
}

cn.close();
log("完了");
