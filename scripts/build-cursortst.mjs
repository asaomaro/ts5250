// 実機に「上で入力 → Enter → 上がプロテクト、下が展開」の画面を作る。
//   <LIB>/CURSORTST … 表示ファイル
//   <LIB>/CURSORCL  … 動かす CL
//
// **確かめたいこと**: 2 画面目でホストが `DSPATR(PC)` を付けた**下の入力欄**に
// カーソルが行くか。利用者から「下の入力項目にフォーカスが自動設定されない」と報告があった。
//
// 仕掛けは指示 50 ひとつ:
//   50 オフ（1 画面目）… CODE だけ入力可。下の欄は出さない
//   50 オン（2 画面目）… CODE をプロテクト、NAME / QTY を出し、NAME に DSPATR(PC)
//
// 実行: node --env-file=.env --env-file=.env.verify scripts/build-cursortst.mjs
import { CommandConnection } from "@ts5250/hostserver";

const LIB = process.env.AS400_LIB ?? "TESTLIB";
const log = (s) => process.stdout.write(s + "\n");

const put = (base, pos, str) => {
  const a = base.split("");
  for (let i = 0; i < str.length; i++) a[pos - 1 + i] = str[i];
  return a.join("");
};
const blank = () => " ".repeat(80);
/**
 * 機能欄（45〜80）。`ind` は条件指示（例 "N50" / " 50"）。
 *
 * **条件指示は 8〜10 桁**（8=N、9-10=指示番号）——このリポジトリの DDS は
 * 「6 桁目に `A`」を基準に組み立てており、その並びで実機のコンパイラが受け付ける位置を
 * 総当たりで確かめた（7-8・8-9・10-11 はいずれも `CPF7311` で落ちる）。
 * 条件つきの行を書くのはこのスクリプトが最初なので、ここに残しておく。
 */
const kwd = (t, ind = "") => put(put(put(blank(), 6, "A"), 8, ind), 45, t).replace(/ +$/, "");
const rec = (n) => put(put(put(blank(), 6, "A"), 17, "R"), 19, n).replace(/ +$/, "");
const cons = (r, c, t, ind = "") =>
  put(put(put(put(put(blank(), 6, "A"), 8, ind), 39, String(r).padStart(3)), 42, String(c).padStart(3)), 45, `'${t}'`).replace(/ +$/, "");
const fld = (name, len, type, dec, use, r, c, ind = "") => {
  let s = put(blank(), 6, "A");
  s = put(s, 8, ind);
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
  rec("MAIN"),
  kwd("CA03(03)"),
  cons(1, 2, "CURSORTST  EXPAND/PROTECT"),
  cons(3, 2, "CODE  :"),
  // 上の入力欄。2 画面目（指示 50 オン）はプロテクトする
  fld("CODE", 6, "A", "", "B", 3, 12),
  kwd("DSPATR(PR)", " 50"),
  // 下は 2 画面目でだけ出す。**カーソルはここへ**（DSPATR(PC)）
  cons(8, 2, "--- DETAIL ---", " 50"),
  cons(10, 2, "NAME  :", " 50"),
  fld("NAME", 10, "A", "", "B", 10, 12, " 50"),
  kwd("DSPATR(PC)", " 50"),
  cons(12, 2, "QTY   :", " 50"),
  fld("QTY", 5, "S", 0, "B", 12, 12, " 50"),
  cons(23, 2, "F3=Exit   Enter=Next", "")
];

/**
 * 変種: **カーソルを指定しない**（`DSPATR(PC)` を付けない）。
 *
 * 実アプリでは珍しくない書き方で、このときホストは「前のカーソル位置」を送ってくる
 * ——それは**いまプロテクトになった上の欄**である。実機の端末は入力できる最初の桁へ寄せる。
 */
const DDS2 = DDS.filter((l) => !l.includes("DSPATR(PC)")).map((l) => l.replace("CURSORTST  EXPAND/PROTECT", "CURSORTS2  NO PC ATTR"));

/**
 * 変種 3: **カーソルをプロテクトされた上の欄に置く**（`DSPATR(PC)` を CODE 側へ）。
 *
 * 「上を読み終えたのでプロテクトし、続きは下」という画面で、アプリがカーソルを
 * 動かし忘れる形。ホストの言うとおりに置くと**入力できない桁**にカーソルが立つ。
 */
const DDS3 = DDS
  .filter((l) => !l.includes("DSPATR(PC)"))
  .flatMap((l) =>
    l.includes("DSPATR(PR)") ? [l, kwd("DSPATR(PC)", " 50")] : [l]
  )
  .map((l) => l.replace("CURSORTST  EXPAND/PROTECT", "CURSORTS3  PC ON PROTECTED"));

const CL = [
  "             PGM",
  `             DCLF       FILE(${LIB}/CURSORTST)`,
  "             CHGVAR     VAR(&IN50) VALUE('0')",
  "             SNDRCVF    RCDFMT(MAIN)",
  "             IF         COND(&IN03) THEN(RETURN)",
  // **ソースは ASCII だけにする。** 日本語を混ぜると RUNSQL の文字リテラルが
  // ジョブの CCSID へ変換できず `SQL0330` で落ちる（実機で踏んだ）
  "/* 2nd: protect top, expand bottom, cursor to NAME by DSPATR(PC) */",
  "             CHGVAR     VAR(&IN50) VALUE('1')",
  "             SNDRCVF    RCDFMT(MAIN)",
  "             ENDPGM"
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

async function putSource(file, member, lines, srcType) {
  await cn.run(`DLTF FILE(${LIB}/QTMPSRC)`);
  if (!await run(`CRTSRCPF FILE(${LIB}/QTMPSRC) RCDLEN(112) MBR(QTMPSRC)`)) return false;
  const BATCH = 8;
  for (let i = 0; i < lines.length; i += BATCH) {
    const chunk = lines.slice(i, i + BATCH);
    const values = chunk.map((line, j) => `(${i + j + 1}.00,0,''${line.replace(/'/g, "''''")}'')`).join(",");
    if (!await run(
      `RUNSQL SQL('INSERT INTO ${LIB}.QTMPSRC (SRCSEQ,SRCDAT,SRCDTA) VALUES ${values}') COMMIT(*NONE) DECMPT(*PERIOD)`,
      `  行${i + 1}〜${i + chunk.length}`
    )) return false;
  }
  await cn.run(`CRTSRCPF FILE(${LIB}/${file}) RCDLEN(112)`);
  await cn.run(`RMVM FILE(${LIB}/${file}) MBR(${member})`);
  await cn.run(`ADDPFM FILE(${LIB}/${file}) MBR(${member}) SRCTYPE(${srcType})`);
  return await run(`CPYF FROMFILE(${LIB}/QTMPSRC) TOFILE(${LIB}/${file}) FROMMBR(QTMPSRC) TOMBR(${member}) MBROPT(*REPLACE) FMTOPT(*NOCHK)`, `  ${file}(${member}) へ複写`);
}

log("== DDS ==");
if (!await putSource("QDDSSRC", "CURSORTST", DDS, "DSPF")) process.exit(1);
await cn.run(`DLTF FILE(${LIB}/CURSORTST)`);
if (!await run(`CRTDSPF FILE(${LIB}/CURSORTST) SRCFILE(${LIB}/QDDSSRC) SRCMBR(CURSORTST)`)) process.exit(1);

log("== DDS2（カーソル指定なし）==");
if (!await putSource("QDDSSRC", "CURSORTS2", DDS2, "DSPF")) process.exit(1);
await cn.run(`DLTF FILE(${LIB}/CURSORTS2)`);
if (!await run(`CRTDSPF FILE(${LIB}/CURSORTS2) SRCFILE(${LIB}/QDDSSRC) SRCMBR(CURSORTS2)`)) process.exit(1);

log("== DDS3（プロテクト側にカーソル）==");
if (!await putSource("QDDSSRC", "CURSORTS3", DDS3, "DSPF")) process.exit(1);
await cn.run(`DLTF FILE(${LIB}/CURSORTS3)`);
if (!await run(`CRTDSPF FILE(${LIB}/CURSORTS3) SRCFILE(${LIB}/QDDSSRC) SRCMBR(CURSORTS3)`)) process.exit(1);

log("== CL ==");
if (!await putSource("QCLSRC", "CURSORCL", CL, "CLP")) process.exit(1);
await cn.run(`DLTPGM PGM(${LIB}/CURSORCL)`);
if (!await run(`CRTBNDCL PGM(${LIB}/CURSORCL) SRCFILE(${LIB}/QCLSRC) SRCMBR(CURSORCL)`)) process.exit(1);

log("== CL2（カーソル指定なしの画面を動かす）==");
const CL2 = CL.map((l) => l.replace("CURSORTST", "CURSORTS2"));
if (!await putSource("QCLSRC", "CURSORCL2", CL2, "CLP")) process.exit(1);
await cn.run(`DLTPGM PGM(${LIB}/CURSORCL2)`);
if (!await run(`CRTBNDCL PGM(${LIB}/CURSORCL2) SRCFILE(${LIB}/QCLSRC) SRCMBR(CURSORCL2)`)) process.exit(1);
log("== CL3 ==");
const CL3 = CL.map((l) => l.replace("CURSORTST", "CURSORTS3"));
if (!await putSource("QCLSRC", "CURSORCL3", CL3, "CLP")) process.exit(1);
await cn.run(`DLTPGM PGM(${LIB}/CURSORCL3)`);
if (!await run(`CRTBNDCL PGM(${LIB}/CURSORCL3) SRCFILE(${LIB}/QCLSRC) SRCMBR(CURSORCL3)`)) process.exit(1);
cn.close();
log(`完了。CURSORCL（PC あり）／ CURSORCL2（PC なし）／ CURSORCL3（PC がプロテクト側）`);
