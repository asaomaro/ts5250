// 実機に**アンロックだけの区間**と**ホストの妥当性検査エラー（窓の中を含む）**を出す試験画面を作る。
//
//   ULKDSPF / ULKPGM（CL）。`CALL <LIB>/ULKPGM PARM('<MODE>')`:
//     UNLOCK — SNDF（出力だけ。LOCK 無し＝キーボードを解錠）→ DLYJOB 10 秒 → SNDRCVF（読む）
//              ＝ **「アンロック → 秒単位の処理 → READ」**（`.aidev/backlog/acs-parity.md` の該当項目）
//     RANGE  — SNDRCVF で RANGE(1 5) の欄を読む。範囲外を入れると**システムが WRITE ERROR CODE で返す**
//     WINDOW — 背景を SNDF し、窓（WINDOW キーワード）の中の RANGE(1 5) の欄を SNDRCVF
//              ＝ **WRITE ERROR CODE TO WINDOW** を出させる
//   F3（CA03）で抜ける。
//
// **ソースは既存の QDDSSRC に入れる**（新しいソース・ファイルは作らない。`scripts/build-adjtest.mjs` と同じ方式）。
// **測定が済んだら `--clean` で消す**（DLTPGM / DLTF / RMVM / DROP ALIAS）。
//
// 実行: node --env-file=.env --env-file=.env.verify scripts/build-ulktest.mjs [--clean]
//   AS400_HOST / AS400_USER / AS400_PASSWORD（`.env`）、AS400_LIB（`.env.verify`）。資格情報は出力しない。
import { Session5250 } from "@ts5250/tn5250";

const host = process.env.AS400_HOST, user = process.env.AS400_USER, password = process.env.AS400_PASSWORD;
const LIB = process.env.AS400_LIB ?? "TESTLIB", DDSF = "QDDSSRC";
if (!host || !user || !password) { process.stderr.write("AS400_HOST / AS400_USER / AS400_PASSWORD が要ります（.env）\n"); process.exit(2); }
const ccsid = Number(process.env.AS400_CCSID ?? 930);
const CLEAN = process.argv.includes("--clean");
const log = (s) => process.stderr.write(s + "\n");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rows = (s) => s.cells.map((r) => r.map((c) => c.char).join("").replace(/\s+$/, ""));

// ---- DDS 桁組み立て（build-sgntest.mjs と同じ規則）----
const put = (b, p, str) => { const a = b.split(""); for (let i = 0; i < str.length; i++) a[p - 1 + i] = str[i]; return a.join(""); };
const blank = () => " ".repeat(80);
const kwd = (kw) => put(put(blank(), 6, "A"), 45, kw).replace(/ +$/, "");
const rec = (n) => put(put(put(blank(), 6, "A"), 17, "R"), 19, n).replace(/ +$/, "");
const constant = (r, c, t) => put(put(put(put(blank(), 6, "A"), 39, String(r).padStart(3)), 42, String(c).padStart(3)), 45, `'${t}'`).replace(/ +$/, "");
function field(name, len, shift, usage, r, c, kw = "") {
  let l = put(put(blank(), 6, "A"), 19, name);
  l = put(l, 35 - String(len).length, String(len));
  if (shift) l = put(l, 35, shift);
  l = put(put(put(l, 38, usage), 39, String(r).padStart(3)), 42, String(c).padStart(3));
  if (kw) l = put(l, 45, kw);
  return l.replace(/ +$/, "");
}
function numf(name, len, dec, usage, r, c, kw = "") {
  let l = put(put(blank(), 6, "A"), 19, name);
  l = put(l, 35 - String(len).length, String(len));
  l = put(l, 38 - String(dec).length, String(dec));
  l = put(put(put(l, 38, usage), 39, String(r).padStart(3)), 42, String(c).padStart(3));
  if (kw) l = put(l, 45, kw);
  return l.replace(/ +$/, "");
}
const DDS = [
  rec("SHOW"), kwd("CA03(03)"),
  constant(1, 3, "ULK TEST SHOW"), constant(3, 3, "TYPE HERE:"), field("SHOWF", 10, "A", "B", 3, 20),
  rec("ASK"), kwd("CA03(03)"),
  constant(1, 3, "ULK TEST ASK"), constant(7, 3, "1-5:"), numf("ASKF", 1, 0, "B", 7, 20, "RANGE(1 5)"),
  rec("WINREC"), kwd("CA03(03)"), kwd("WINDOW(6 10 6 40)"),
  constant(1, 2, "WINDOW TEST 1-5:"), numf("WINF", 1, 0, "B", 3, 2, "RANGE(1 5)")
];
const CL = [
  "PGM PARM(&MODE)",
  "DCL VAR(&MODE) TYPE(*CHAR) LEN(8)",
  `DCLF FILE(${LIB}/ULKDSPF)`,
  "IF COND(&MODE *EQ 'UNLOCK') THEN(DO)",
  "  SNDF RCDFMT(SHOW)",
  "  DLYJOB DLY(10)",
  "  SNDRCVF RCDFMT(ASK)",
  "ENDDO",
  "IF COND(&MODE *EQ 'RANGE') THEN(DO)",
  "  SNDRCVF RCDFMT(ASK)",
  "ENDDO",
  "IF COND(&MODE *EQ 'WINDOW') THEN(DO)",
  "  SNDF RCDFMT(SHOW)",
  "  SNDRCVF RCDFMT(WINREC)",
  "ENDDO",
  "ENDPGM"
];

async function run(session, cmd, timeoutMs = 30000) {
  const s = session.snapshot();
  const cf = s.fields.filter((f) => !f.protected).slice(-1)[0];
  session.setField({ index: cf.index }, cmd);
  await session.sendAid("Enter", { cursor: { row: cf.row, col: cf.col }, timeoutMs });
  await sleep(500);
  return session.snapshot();
}
const lastMsg = (snap) => rows(snap).slice(-2).map((x) => x.trim()).filter(Boolean).join(" / ");
const runSql = (session, sql) => run(session, `RUNSQL SQL('${sql.replace(/'/g, "''")}') COMMIT(*NONE)`);
async function injectMember(session, mbr, type, alias, lines) {
  await run(session, `RMVM FILE(${LIB}/${DDSF}) MBR(${mbr})`);
  await run(session, `ADDPFM FILE(${LIB}/${DDSF}) MBR(${mbr}) SRCTYPE(${type})`);
  await runSql(session, `DROP ALIAS ${LIB}/${alias}`);
  await runSql(session, `CREATE ALIAS ${LIB}/${alias} FOR ${LIB}/${DDSF}(${mbr})`);
  // **順序番号（SRCSEQ）を振る**。DDS は 0 のままでも通るが、CL のコンパイラーは昇順でないと
  // CPD0780（ソースの順序番号が正しくない）で落ちる（実機で踏んだ）
  let seq = 0;
  for (const l of lines) {
    seq += 1;
    // 列名を書かない（ソース PF の列は SRCSEQ・SRCDAT・SRCDTA の順）——コマンド行（153 バイト）に収めるため
    const sql = `INSERT INTO ${LIB}/${alias} VALUES(${seq},0,'${l.replace(/'/g, "''")}')`;
    await runSql(session, sql);
  }
  await runSql(session, `DROP ALIAS ${LIB}/${alias}`);
}

const s = await Session5250.connect({ host, ccsid, warn: () => {} });
await sleep(800);
const inputs = s.snapshot().fields.filter((f) => !f.protected);
s.setField({ index: inputs[0].index }, user);
s.setField({ index: inputs[1].index }, password);
await s.sendAid("Enter", { cursor: { row: inputs[0].row, col: inputs[0].col }, timeoutMs: 15000 });
for (let i = 0; i < 6; i++) {
  await sleep(800);
  const t = rows(s.snapshot());
  if (t.some((r) => /===>/.test(r))) break;
  if (t.some((r) => r.includes("対話式ジョブの回復"))) {
    const f = s.snapshot().fields.filter((x) => !x.protected).slice(-1)[0];
    s.setField({ index: f.index }, "90");
    await s.sendAid("Enter", { cursor: { row: f.row, col: f.col }, timeoutMs: 12000 });
  } else await s.sendAid("Enter", { timeoutMs: 10000 });
}
try {
  if (CLEAN) {
    for (const c of [`DLTPGM PGM(${LIB}/ULKPGM)`, `DLTF FILE(${LIB}/ULKDSPF)`, `RMVM FILE(${LIB}/${DDSF}) MBR(ULKDSPF)`, `RMVM FILE(${LIB}/${DDSF}) MBR(ULKPGM)`]) {
      log(`${c}: ${lastMsg(await run(s, c))}`);
    }
    log(`CHKOBJ ULKPGM: ${lastMsg(await run(s, `CHKOBJ OBJ(${LIB}/ULKPGM) OBJTYPE(*PGM)`))}`);
    log(`CHKOBJ ULKDSPF: ${lastMsg(await run(s, `CHKOBJ OBJ(${LIB}/ULKDSPF) OBJTYPE(*FILE)`))}`);
  } else {
    await injectMember(s, "ULKDSPF", "DSPF", "ULKDA", DDS);
    await run(s, `DLTF FILE(${LIB}/ULKDSPF)`);
    // **DFRWRT(*NO)**: 既定の *YES だと SNDF の出力が次の READ まで遅れ、「出力だけ・解錠」の区間が作れない
    // （実機で踏んだ。10 秒間ずっと前の画面のまま施錠が続いた）
    let r = await run(s, `CRTDSPF FILE(${LIB}/ULKDSPF) SRCFILE(${LIB}/${DDSF}) SRCMBR(ULKDSPF) DFRWRT(*NO)`, 40000);
    log(`CRTDSPF: ${lastMsg(r)}`);
    await injectMember(s, "ULKPGM", "CLLE", "ULKCA", CL);
    await run(s, `DLTPGM PGM(${LIB}/ULKPGM)`);
    r = await run(s, `CRTBNDCL PGM(${LIB}/ULKPGM) SRCFILE(${LIB}/${DDSF}) SRCMBR(ULKPGM)`, 40000);
    log(`CRTBNDCL: ${lastMsg(r)}`);
  }
} finally {
  await run(s, "SIGNOFF").catch(() => {});
  s.disconnect();
}
