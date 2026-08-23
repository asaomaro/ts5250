// 実機の TESTLIB に「サブファイルレコードのある画面」を作成・コンパイル・実行する。
//   - EMPMST : 社員マスター物理ファイル（SQL CREATE TABLE + INSERT）
//   - EMPDSPF: サブファイル表示ファイル（SFL01 / SFLCTL CTL01, SFLSIZ/SFLPAG/SFLDSP/SFLEND(*MORE)）
//   - EMPSFR : EMPMST を読み SFL01 をロードして EXFMT CTL01 する RPGLE
// ソース投入は IFS/FTP 不要。コマンド行から RUNSQL INSERT（1 行=1 リテラル、COMMIT(*NONE)）。
// 実行: node --env-file=.env scripts/build-empsfl.mjs
import { readFileSync } from "node:fs";
import { Session5250 } from "@ts5250/tn5250";
import { codecForCcsid } from "@ts5250/tn5250/codec";
import { SecretCrypto } from "../packages/server/dist/secret-crypto.js";

const LIB = "TESTLIB", DDSF = "QDDSSRC", RPGF = "QRPGLESRC";
// 日本語ラベルは DDS 定数にすると SO/SI がコマンド行 SQL の引用符入れ子を壊すため、
// CTL01 の出力フィールドにして RPG の 16 進リテラル x'0E..0F'（純 ASCII）で埋める。
const cp939 = codecForCcsid(939);
const hx = (jp) => Array.from(cp939.encode(jp).bytes).map((b) => b.toString(16).padStart(2, "0")).join("").toUpperCase();
const LABELS = [
  { name: "TITLE", w: 20, r: 1, c: 2, jp: "社員マスター一覧" },
  { name: "LEXIT", w: 10, r: 1, c: 65, jp: "F3=終了" },
  { name: "LNO", w: 6, r: 6, c: 2, jp: "番号" },
  { name: "LNAME", w: 6, r: 6, c: 9, jp: "氏名" },
  { name: "LDEPT", w: 6, r: 6, c: 32, jp: "部門" },
  { name: "LSAL", w: 6, r: 6, c: 48, jp: "給与" },
];
const log = (s) => process.stderr.write(s + "\n");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rows = (s) => s.cells.map((r) => r.map((c) => c.char).join("").replace(/\s+$/, ""));
const msgOf = (s) => rows(s).slice(-4).map((t) => t.trim()).filter(Boolean).join(" / ");
const dump = (snap, tag) => {
  log(`\n===== ${tag} =====`);
  rows(snap).forEach((r, i) => { if (r.trim()) log(String(i + 1).padStart(2) + "|" + r); });
};

// ---- DDS を桁位置で組み立てる（build-attrtest.mjs と同方式） ----
const put = (base, pos, str) => { const a = base.split(""); for (let i = 0; i < str.length; i++) a[pos - 1 + i] = str[i]; return a.join(""); };
const blank = () => " ".repeat(80);
const kwd = (kw) => put(put(blank(), 6, "A"), 45, kw).replace(/ +$/, "");                        // 記録/ファイルレベル・キーワード
const condKwd = (ind, kw) => put(put(put(blank(), 6, "A"), 9, String(ind)), 45, kw).replace(/ +$/, ""); // 標識で条件付け
const rec = (n) => put(put(put(blank(), 6, "A"), 17, "R"), 19, n).replace(/ +$/, "");
function field(name, len, type, usage, r, c) {
  let l = put(put(blank(), 6, "A"), 19, name);
  l = put(l, 35 - String(len).length, String(len));   // 30-34 に長さ右詰
  if (type) l = put(l, 35, type);                      // 35=データ型（A=文字）
  l = put(put(put(l, 38, usage), 39, String(r).padStart(3)), 42, String(c).padStart(3));
  return l.replace(/ +$/, "");
}

// ---- サブファイル DDS ----
// 注意: この機（V7R3, CCSID 939）ではサブファイル制御レコードにサブファイル先頭行より
// 下の行の定数を置くと CPD7812（制御レコードとサブファイルの重なり）で失敗する。
// そのため F3=EXIT はヘッダー行（1 行目）に置き、サブファイルの下にフッターを置かない。
const DDS = [
  rec("SFL01"), kwd("SFL"),
  field("SENUM", 5, "A", "O", 8, 2),
  field("SENAME", 20, "O", "O", 8, 9),    // O=DBCS-open（日本語氏名）
  field("SEDEPT", 14, "O", "O", 8, 32),   // O=DBCS-open（日本語部門）
  field("SESAL", 11, "A", "O", 8, 48),
  rec("CTL01"), kwd("SFLCTL(SFL01)"),
  kwd("SFLSIZ(0014)"), kwd("SFLPAG(0010)"), kwd("OVERLAY"),
  condKwd(31, "SFLDSP"), condKwd(32, "SFLDSPCTL"), condKwd(33, "SFLCLR"),
  condKwd(34, "SFLEND(*MORE)"),
  kwd("CA03(03)"),
  ...LABELS.map((l) => field(l.name, l.w, "O", "O", l.r, l.c)),  // 日本語ラベル（出力フィールド）
];

// ---- RPGLE（INDARA 無し。条件標識 31-34 は *INxx で直接制御） ----
const RPG = [
  "**free",
  "dcl-f EMPDSPF workstn sfile(SFL01:rrn);",
  "dcl-f EMPMST rename(EMPMST:EMPREC);",   // 様式名がファイル名と衝突するため改名
  "dcl-s rrn packed(4:0);",
  ...LABELS.map((l) => `${l.name} = x'${hx(l.jp)}';`),  // 日本語ラベルを 16 進で設定
  "*in33 = *on;",          // SFLCLR
  "write CTL01;",
  "*in33 = *off;",
  "rrn = 0;",
  "read EMPREC;",
  "dow not %eof(EMPMST);",
  "  SENUM  = ENUM;",
  "  SENAME = ENAME;",
  "  SEDEPT = EDEPT;",
  "  SESAL  = %char(ESAL);",
  "  rrn += 1;",
  "  write SFL01;",
  "  read EMPREC;",
  "enddo;",
  "if rrn > 0;",
  "  *in31 = *on;",        // SFLDSP
  "endif;",
  "*in32 = *on;",          // SFLDSPCTL
  "*in34 = *on;",          // SFLEND(*MORE)
  "exfmt CTL01;",
  "*inlr = *on;",
  "return;",
];

// ---- 社員データ ----
const EMP = [
  ["00001", "田中太郎", "営業部", 350000], ["00002", "鈴木花子", "営業部", 420000],
  ["00003", "佐藤一郎", "開発部", 480000], ["00004", "高橋健太", "開発部", 510000],
  ["00005", "渡辺美咲", "開発部", 390000], ["00006", "伊藤三郎", "総務部", 300000],
  ["00007", "山本裕子", "総務部", 330000], ["00008", "中村大輔", "品質部", 360000],
  ["00009", "小林恵子", "品質部", 345000], ["00010", "加藤望", "人事部", 400000],
  ["00011", "吉田純一", "人事部", 375000], ["00012", "山田悠真", "営業部", 455000],
  ["00013", "森田玲奈", "開発部", 530000], ["00014", "林勇気", "支援部", 315000],
];

// ---- コマンド実行（メインメニューのコマンド行=最後の非保護フィールド） ----
async function run(session, cmd, timeoutMs = 30000) {
  const s = session.snapshot();
  const cf = s.fields.filter((f) => !f.protected).slice(-1)[0];
  session.setField({ index: cf.index }, cmd);
  const scr = (await session.sendAid("Enter", { cursor: { row: cf.row, col: cf.col }, timeoutMs })).screen;
  await sleep(500);
  return session.snapshot() ?? scr;
}
const runSql = (session, sql) => run(session, `RUNSQL SQL('${sql.replace(/'/g, "''")}') COMMIT(*NONE)`);
function insertSrc(alias, line) {
  const sqlVal = "'" + line.replace(/'/g, "''") + "'";
  const sql = `INSERT INTO ${LIB}/${alias} (SRCDTA) VALUES(${sqlVal})`;
  return `RUNSQL SQL('${sql.replace(/'/g, "''")}') COMMIT(*NONE)`;
}
async function injectMember(session, srcf, mbr, alias, lines) {
  await run(session, `RMVM FILE(${LIB}/${srcf}) MBR(${mbr})`);
  await run(session, `ADDPFM FILE(${LIB}/${srcf}) MBR(${mbr})`);
  await runSql(session, `DROP ALIAS ${LIB}/${alias}`);
  await runSql(session, `CREATE ALIAS ${LIB}/${alias} FOR ${LIB}/${srcf}(${mbr})`);
  for (const l of lines) {
    const cmd = insertSrc(alias, l);
    if (cmd.length > 240) throw new Error(`command too long (${cmd.length}): ${l}`);
    await run(session, cmd);
  }
}

// ---- 接続＋手動サインオン＋情報画面スキップでコマンド画面へ ----
async function connectHost(sys, password) {
  const dev = ("WEBSF" + String(Date.now()).slice(-4)).slice(0, 10);
  const s = await Session5250.connect({
    host: sys.host, port: sys.port ?? 23, ccsid: sys.ccsid ?? 37, screenSize: "27x132",
    deviceName: dev, user: sys.signon.user, password, warn: (w) => log("WARN: " + w),
  });
  await sleep(1500);
  const inputs = s.snapshot().fields.filter((f) => !f.protected);
  s.setField({ index: inputs[0].index }, sys.signon.user);
  s.setField({ index: inputs[1].index }, password);
  await s.sendAid("Enter", { cursor: { row: inputs[0].row, col: inputs[0].col }, timeoutMs: 15000 });
  await sleep(800);
  for (let i = 0; i < 6; i++) {
    const snap = s.snapshot();
    const isMenu = rows(snap).some((r) => r.includes("選択項目またはコマンド") || r.includes("メインメニュー"));
    const cmd = snap.fields.filter((f) => !f.protected).slice(-1)[0];
    if (isMenu && cmd) { log(`command screen reached (dev=${dev})`); return s; }
    await s.sendAid("Enter", { timeoutMs: 10000 });
    await sleep(800);
  }
  throw new Error("could not reach command screen");
}

// ================= main =================
const conns = JSON.parse(readFileSync("connections.json", "utf8"));
const sys = conns.systems.find((s) => s.name === (process.env.AS400_SYSTEM ?? "AS400"));
const password = SecretCrypto.fromEnv().decrypt(sys.signon.passwordEnc);

const session = await connectHost(sys, password);
try {
  await run(session, `ADDLIBLE ${LIB}`); // 見つからない用（既にあれば無害）

  // 1) ソース物理ファイル（無ければ作成）
  await run(session, `CRTSRCPF FILE(${LIB}/${DDSF}) RCDLEN(92) TEXT('DDS source')`);
  await run(session, `CRTSRCPF FILE(${LIB}/${RPGF}) RCDLEN(92) TEXT('RPGLE source')`);

  // 2) 社員マスター（PF）を作成しデータ投入
  await run(session, `DLTF FILE(${LIB}/EMPMST)`);
  let s = await runSql(session, `CREATE TABLE ${LIB}/EMPMST (ENUM CHAR(5), ENAME CHAR(20), EDEPT CHAR(14), ESAL DECIMAL(7, 0))`);
  log("CREATE TABLE EMPMST: " + msgOf(s));
  for (const [n, nm, dp, sal] of EMP) {
    await runSql(session, `INSERT INTO ${LIB}/EMPMST VALUES('${n}', '${nm}', '${dp}', ${sal})`);
  }
  log(`inserted ${EMP.length} rows into EMPMST`);

  // 3) 表示ファイル（サブファイル）
  await injectMember(session, DDSF, "EMPDSPF", "EMPDA", DDS);
  await run(session, `DLTF FILE(${LIB}/EMPDSPF)`);
  s = await run(session, `CRTDSPF FILE(${LIB}/EMPDSPF) SRCFILE(${LIB}/${DDSF}) SRCMBR(EMPDSPF)`, 40000);
  log("CRTDSPF EMPDSPF: " + msgOf(s));

  // 4) RPGLE プログラム
  await injectMember(session, RPGF, "EMPSFR", "EMPRA", RPG);
  await run(session, `DLTPGM PGM(${LIB}/EMPSFR)`);
  s = await run(session, `CRTBNDRPG PGM(${LIB}/EMPSFR) SRCFILE(${LIB}/${RPGF}) SRCMBR(EMPSFR)`, 60000);
  log("CRTBNDRPG EMPSFR: " + msgOf(s));

  // 5) 実行してサブファイル画面をダンプ
  s = await run(session, `CALL ${LIB}/EMPSFR`, 20000);
  dump(s, "EMPSFR — サブファイル画面");
  log("\ninputs: " + s.fields.filter((f) => !f.protected).map((f) => `#${f.index}(r${f.row}c${f.col})`).join(" "));

  // F3 で終了してメニューへ戻す
  await session.sendAid("F3", { timeoutMs: 10000 }).catch(() => {});
  await sleep(500);
} catch (e) {
  log("BUILD ERROR: " + e.message + "\n" + (e.stack ?? ""));
} finally {
  await session.disconnect();
}
