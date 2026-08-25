// 実機に「入力欄の型ごとの打鍵規則」を確かめる画面を作る。
//   <LIB>/AUDDSPF … 表示ファイル（記述は下の DDS 配列）
//   <LIB>/AUDPGM  … RPG（打鍵して送った値をそのまま画面へ返す＝**ホストが受け取った値**）
//
// **何を見るための画面か。** 端末側の打鍵規則は「打てるか」だけでは足りない——
// *打てたものがそのままホストへ届くか*までを見ないと、次の 3 つを取り逃がす。
//   ① 数字専用（DDS 35 桁の `D`）に `.` `,` `+` `-` 空白が打ててしまう
//      → 送信時に core が `FIELD_TYPE` で弾き、**1 バイトも飛ばない**（画面は無反応）
//   ② その `-` / `+` が Field− / Field+ に化け、**カーソル以降が消えて次欄へ飛ぶ**
//   ③ 符号付き数値（`6S 0`＝ワイヤ長 7）の**符号桁に数字が打て**、画面は `1234567` なのに
//      ホストは `123456` を受け取る（送信時に符号桁を落とすため）
//
// そのため入力欄（TXT / DGT / SGN）と、**ホストが受け取った値**を出す欄（ETXT / EDGT / ESGN）
// を対にして置く。NXT は②の「次欄へ飛んだか」を見るための後続欄。
//
// ソース投入は IFS/FTP 不要。RUNSQL で QTMPSRC に入れて CPYF で移す（build-revtest.mjs と同方式）。
// 資格情報は環境変数からのみ受け取る（引数はプロセス一覧に見える）。
//   node --env-file=.env --env-file=.env.verify scripts/build-audpgm.mjs
// 実機での使い方:
//   ADDLIBLE ASAOLIB
//   CALL ASAOLIB/AUDPGM     （F3 で終了）
import { CommandConnection } from "@ts5250/hostserver";

const LIB = process.env.AS400_LIB ?? "TESTLIB";
const log = (s) => process.stdout.write(s + "\n");

// --- DDS を桁位置で組み立てる（build-revtest.mjs と同じ道具）---
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
/**
 * 名前つき欄。桁は DDS の定位置——名前 19〜28 / 長さ 30〜34 / **型（キーボードシフト）35** /
 * 小数桁 36〜37 / 用途 38 / 行 39〜41 / 桁 42〜44。
 * 型がこの検証の主役: `D`=数字専用（FFW シフト 5）、`S`=符号付き数値（シフト 7・ワイヤ長は桁数+1）。
 */
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
  rec("AUDR"),
  kwd("CA03(03)"),
  cons(1, 2, "AUDPGM FIELD RULE TEST"),
  cons(3, 2, "TXT (A)"),
  fld("TXT", 10, "A", "", "B", 3, 30),
  cons(5, 2, "DGT (DIGITS ONLY)"),
  fld("DGT", 6, "D", "", "B", 5, 30),
  cons(7, 2, "SGN (SIGNED NUMERIC)"),
  fld("SGN", 6, "S", 0, "B", 7, 30),
  cons(9, 2, "NXT (NEXT FIELD)"),
  fld("NXT", 10, "A", "", "B", 9, 30),
  cons(12, 2, "HOST RECEIVED"),
  cons(14, 2, "TXT"),
  fld("ETXT", 10, "A", "", "O", 14, 30),
  cons(16, 2, "DGT"),
  fld("EDGT", 6, "A", "", "O", 16, 30),
  cons(18, 2, "SGN"),
  fld("ESGN", 6, "S", 0, "O", 18, 30),
  cons(22, 2, "ENTER=SEND  F3=EXIT")
];

// **打った値をそのまま返すだけ**（判定はしない）。端末が何を送ったかを画面で見る。
const RPG = [
  "**free",
  // **ライブラリーを名指しする**（`extdesc` はコンパイル時の記述、`extfile` は実行時のファイル）。
  // *LIBL 任せだと `ADDLIBLE` を忘れた実機で CPF4101 になり、画面が出ない。
  `dcl-f AUDDSPF workstn extdesc('${LIB}/AUDDSPF') extfile(*extdesc);`,
  "dou *in03;",
  "  exfmt AUDR;",
  "  ETXT = TXT;",
  "  EDGT = DGT;",
  "  ESGN = SGN;",
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

/** ソース行を QTMPSRC 経由でメンバーに入れる（build-revtest.mjs と同じ手順） */
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
    // DECMPT(*PERIOD): pub400 は QDECFMT=J（小数点がカンマ）で既定の *JOB だと SQL0104
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

log("== DDS（AUDDSPF: 型ごとの入力欄 ＋ ホストが受け取った値）==");
if (!await putSource("QDDSSRC", "AUDDSPF", "DSPF", DDS)) process.exit(1);
await cn.run(`DLTF FILE(${LIB}/AUDDSPF)`);
if (!await run(`CRTDSPF FILE(${LIB}/AUDDSPF) SRCFILE(${LIB}/QDDSSRC) SRCMBR(AUDDSPF)`)) {
  log("(コンパイル失敗。上のメッセージを見て DDS を直す)");
  process.exit(1);
}

log("== RPG（AUDPGM）==");
// 外部記述は `extdesc` でライブラリーごと名指ししてあるので *LIBL に依らない
if (!await putSource("QRPGLESRC", "AUDPGM", "RPGLE", RPG)) process.exit(1);
await cn.run(`DLTPGM PGM(${LIB}/AUDPGM)`);
if (!await run(`CRTBNDRPG PGM(${LIB}/AUDPGM) SRCFILE(${LIB}/QRPGLESRC) SRCMBR(AUDPGM) DFTACTGRP(*NO)`)) process.exit(1);

cn.close();
log(`完了。実機では  CALL ${LIB}/AUDPGM  （F3 で終了）`);
