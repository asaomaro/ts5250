// 表示属性 E2E 用のテスト画面を実機（PUB400 等）に作成・コンパイルする。
// DDS 表示ファイル CLRTDSP と RPGLE プログラム CLRTPGM を <LIB>（既定 MYLIB）へ作る。
// ソース投入は IFS/FTP 不要で、コマンド行から RUNSQL INSERT（各行を単一 SQL 文字列リテラルで）。
//   - SQL 連結 || は不可（ホストが変体文字 | を認識せず "Token | was not valid"）→ 1 行=1 リテラル。
//   - RUNSQL は COMMIT(*NONE) 必須。CL の引用符二重化＋コマンド行 153 桁制限に収める。
// 冪等（RMVM/ADDPFM/DROP+CREATE ALIAS/DLTF/DLTPGM）。作成後は scripts/verify-attributes.mjs で検証。
// 実行: node --env-file=.env scripts/build-attrtest.mjs
import { Session5250 } from "@as400web/core";

const LIB = process.env.PUB400_LIB ?? "MYLIB";
const DDSF = "QDDSSRC", RPGF = "QRPGLESRC";
const DSPF = "CLRTDSP", PGM = "CLRTPGM", DDSMBR = "CLRTDSP", RPGMBR = "CLRTPGM";
const DDSALIAS = "A1", RPGALIAS = "R1";
const log = (s) => process.stderr.write(s + "\n");

// --- DDS 行を桁位置で組み立てる ---
const put = (base, pos, str) => { const a = base.split(""); for (let i = 0; i < str.length; i++) a[pos - 1 + i] = str[i]; return a.join(""); };
const blank = () => " ".repeat(80);
const fileKwd = (kw) => put(put(blank(), 6, "A"), 45, kw).replace(/ +$/, "");
const rec = (n) => put(put(put(blank(), 6, "A"), 17, "R"), 19, n).replace(/ +$/, "");
const constant = (r, c, t, kw = "") => put(put(put(put(blank(), 6, "A"), 39, String(r).padStart(3)), 42, String(c).padStart(3)), 45, `'${t}'${kw ? " " + kw : ""}`).replace(/ +$/, "");
function field(name, len, usage, r, c) {
  let l = put(blank(), 6, "A");
  l = put(l, 19, name);
  l = put(l, 35 - String(len).length, String(len)); // 30-34 に右詰
  l = put(l, 38, usage);
  l = put(put(l, 39, String(r).padStart(3)), 42, String(c).padStart(3));
  return l.replace(/ +$/, "");
}

const dds = [
  fileKwd("DSPSIZ(24 80 *DS3)"), rec("FMT01"), fileKwd("CA03(03)"),
  constant(1, 2, "ATTR TEST"), constant(1, 60, "F3=EXIT"),
  constant(3, 2, "GRN", "COLOR(GRN)"), constant(3, 20, "WHT", "COLOR(WHT)"), constant(3, 40, "RED", "COLOR(RED)"), constant(3, 60, "TRQ", "COLOR(TRQ)"),
  constant(4, 2, "YLW", "COLOR(YLW)"), constant(4, 20, "PNK", "COLOR(PNK)"), constant(4, 40, "BLU", "COLOR(BLU)"),
  constant(6, 2, "RVS", "DSPATR(RI)"), constant(6, 20, "UL", "DSPATR(UL)"), constant(6, 40, "HI", "DSPATR(HI)"),
  constant(7, 2, "BL", "DSPATR(BL)"), constant(7, 20, "CS", "DSPATR(CS)"),
  constant(8, 2, "REDBL", "COLOR(RED) DSPATR(BL)"),
  constant(9, 2, "DBCS:"), field("DBFLD", 12, "O", 9, 8), constant(11, 2, "F3 END")
];
// RPG: DBFLD へ SO+日本語+SI(ccsid1399) を出力し FMT01 を EXFMT、F3 で終了
const rpg = ["**free", "dcl-f " + DSPF + " workstn;", "DBFLD = x'0E4562456648E70F';", "exfmt FMT01;", "*inlr = *on;", "return;"];

const cmdField = (s) => { const e = s.fields.filter((f) => !f.protected); return e[e.length - 1]; };
const rows = (s) => s.cells.map((r) => r.map((c) => c.char).join(""));
const msgOf = (s) => rows(s).slice(-3).map((t) => t.trim()).filter(Boolean).join(" / ");

async function run(session, cmd, timeoutMs = 15000) {
  const s = session.snapshot(); const cf = cmdField(s);
  session.setField({ index: cf.index }, cmd);
  return (await session.sendAid("Enter", { cursor: { row: cf.row, col: cf.col }, timeoutMs })).screen;
}
function insertCmd(alias, line) {
  const sqlVal = "'" + line.replace(/'/g, "''") + "'";
  const sql = `INSERT INTO ${LIB}/${alias} (SRCDTA) VALUES(${sqlVal})`;
  return `RUNSQL SQL('${sql.replace(/'/g, "''")}') COMMIT(*NONE)`;
}
async function injectMember(session, srcf, mbr, alias, lines) {
  await run(session, `RMVM FILE(${LIB}/${srcf}) MBR(${mbr})`);
  await run(session, `ADDPFM FILE(${LIB}/${srcf}) MBR(${mbr})`);
  await run(session, `RUNSQL SQL('DROP ALIAS ${LIB}/${alias}') COMMIT(*NONE)`);
  await run(session, `RUNSQL SQL('CREATE ALIAS ${LIB}/${alias} FOR ${LIB}/${srcf}(${mbr})') COMMIT(*NONE)`);
  for (const l of lines) {
    const cmd = insertCmd(alias, l);
    if (cmd.length > 153) throw new Error(`command line too long (${cmd.length}>153): ${l}`);
    await run(session, cmd);
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function connectHost() {
  // 切断後のデバイス保持に備え、リトライごとにデバイス名を変える
  const base = process.env.PUB400_DEVNAME ?? "WEBATB";
  let last;
  for (let i = 0; i < 5; i++) {
    try {
      const s = await Session5250.connect({
        host: process.env.PUB400_HOST ?? "pub400.com", port: 23,
        deviceName: `${base}${i}`.slice(0, 10),
        user: process.env.PUB400_USER, password: process.env.PUB400_PASSWORD, warn: (w) => log("WARN: " + w)
      });
      await s.waitForScreen({ timeoutMs: 8000, until: { text: "Main Menu" } }).catch(() => {});
      if (cmdField(s.snapshot())) return s;
      s.disconnect();
    } catch (e) { last = e; log(`connect retry ${i + 1}: ${e.message}`); }
    await sleep(2000);
  }
  throw last ?? new Error("could not reach a command screen");
}
const session = await connectHost();
let ok = true;
try {
  log(`build attr-test in ${LIB} (CLRTDSP/CLRTPGM)…`);
  await injectMember(session, DDSF, DDSMBR, DDSALIAS, dds);
  await run(session, `DLTF FILE(${LIB}/${DSPF})`);
  let s = await run(session, `CRTDSPF FILE(${LIB}/${DSPF}) SRCFILE(${LIB}/${DDSF}) SRCMBR(${DDSMBR})`, 30000);
  const dspfOk = /created in library/i.test(rows(s).join("\n"));
  log(`CRTDSPF: ${dspfOk ? "OK" : "NG — " + msgOf(s)}`);

  await injectMember(session, RPGF, RPGMBR, RPGALIAS, rpg);
  await run(session, `DLTPGM PGM(${LIB}/${PGM})`);
  s = await run(session, `CRTBNDRPG PGM(${LIB}/${PGM}) SRCFILE(${LIB}/${RPGF}) SRCMBR(${RPGMBR})`, 40000);
  const pgmOk = /placed in library/i.test(rows(s).join("\n"));
  log(`CRTBNDRPG: ${pgmOk ? "OK" : "NG — " + msgOf(s)}`);
  ok = dspfOk && pgmOk;
} catch (e) {
  ok = false; log("BUILD ERROR: " + e.message);
} finally {
  await session.disconnect();
}
log(ok ? `OK — ${LIB}/CLRTDSP + ${LIB}/CLRTPGM をビルドしました（verify-attributes.mjs で検証可）` : "NG — ビルド失敗");
process.exit(ok ? 0 : 1);
