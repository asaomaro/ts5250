// 全7色 × {無印, DSPATR(UL), DSPATR(CS), DSPATR(UL) DSPATR(CS) 併用} の実際のコンパイル結果
// （実際にホストが送る属性バイト、または WEA 等の別経路になるか）を実機で確認する。
// .aidev/works/20260914-dspfmt-field-underline-instability/requirements.md AC2, AC6
//
// packages/tn5250/src/screen/attributes.ts の ATTR_TABLE（0x20-0x3F、32エントリ）には、
// 黄(YLW)・青緑(TRQ) 以外の色に CS（桁区切り）版が1つも無い。DDS で COLOR(RED) DSPATR(CS)
// のように「CSの版が無い色」に CS を要求したとき、実機は何を送ってくるか（コンパイルエラーに
// なる／CSが無視される／WEAで送る、のいずれか）を実際に確かめる。
//
// 実行: node --env-file=.env --env-file=.env.verify scripts/build-colsep-matrix.mjs
import { Session5250 } from "@ts5250/tn5250";

const LIB = process.env.AS400_LIB ?? "TESTLIB";
const DDSF = "QDDSSRC", RPGF = "QRPGLESRC";
const log = (s) => process.stderr.write(s + "\n");

const put = (base, pos, str) => { const a = base.split(""); for (let i = 0; i < str.length; i++) a[pos - 1 + i] = str[i]; return a.join(""); };
const blank = () => " ".repeat(80);
const fileKwd = (kw) => put(put(blank(), 6, "A"), 45, kw).replace(/ +$/, "");
const rec = (n) => put(put(put(blank(), 6, "A"), 17, "R"), 19, n).replace(/ +$/, "");
const constant = (r, c, t, kw = "") => put(put(put(put(blank(), 6, "A"), 39, String(r).padStart(3)), 42, String(c).padStart(3)), 45, `'${t}'${kw ? " " + kw : ""}`).replace(/ +$/, "");

const COLORS = ["GRN", "WHT", "RED", "TRQ", "YLW", "PNK", "BLU"];
let row = 3;
const dds = [fileKwd("DSPSIZ(24 80 *DS3)"), rec("FMT01"), fileKwd("CA03(03)"), constant(1, 2, "COLSEP MATRIX TEST")];
for (const c of COLORS) {
  dds.push(constant(row, 2, c, `COLOR(${c})`));
  dds.push(constant(row, 10, "UL", `COLOR(${c}) DSPATR(UL)`));
  dds.push(constant(row, 18, "CS", `COLOR(${c}) DSPATR(CS)`));
  row++;
}
// UL+CS の併用は別スクリプトで代表色のみ後追い確認する
// （実機のコマンド行153桁制限のため、単独キーワードのこの行数に収める方を優先した）。
dds.push(constant(row + 1, 2, "F3=END"));

const fx = { dsp: "CSMDSPF", pgm: "CSMPGM", ddsMbr: "CSMDSPF", rpgMbr: "CSMPGM", ddsAlias: "CSMA", rpgAlias: "CSMR", dds,
  rpg: ["**free", "dcl-f CSMDSPF workstn;", "exfmt FMT01;", "*inlr = *on;", "return;"] };

function insertCmd(alias, line) {
  const sqlVal = "'" + line.replace(/'/g, "''") + "'";
  const sql = `INSERT INTO ${LIB}/${alias} (SRCDTA) VALUES(${sqlVal})`;
  return `RUNSQL SQL('${sql.replace(/'/g, "''")}') COMMIT(*NONE)`;
}
const cmdField = (s) => { const e = s.fields.filter((f) => !f.protected); return e[e.length - 1]; };
const rows = (s) => s.cells.map((r) => r.map((c) => c.char).join(""));
const msgOf = (s) => rows(s).slice(-3).map((t) => t.trim()).filter(Boolean).join(" / ");
async function run(session, c, timeoutMs = 15000) {
  const s = session.snapshot(); const cf = cmdField(s);
  session.setField({ index: cf.index }, c);
  const r = await session.sendAid("Enter", { cursor: { row: cf.row, col: cf.col }, timeoutMs });
  return r.screen;
}
async function injectMember(session, srcf, mbr, alias, lines) {
  await run(session, `RMVM FILE(${LIB}/${srcf}) MBR(${mbr})`);
  await run(session, `ADDPFM FILE(${LIB}/${srcf}) MBR(${mbr})`);
  await run(session, `RUNSQL SQL('DROP ALIAS ${LIB}/${alias}') COMMIT(*NONE)`);
  await run(session, `RUNSQL SQL('CREATE ALIAS ${LIB}/${alias} FOR ${LIB}/${srcf}(${mbr})') COMMIT(*NONE)`);
  for (const l of lines) {
    const c = insertCmd(alias, l);
    if (c.length > 153) throw new Error(`command line too long (${c.length}>153): ${l}`);
    await run(session, c);
  }
}

const host = process.env.AS400_HOST, user = process.env.AS400_USER, password = process.env.AS400_PASSWORD;
if (!host || !user || !password) { log("AS400_* が要ります"); process.exit(2); }
const session = await Session5250.connect({ host, port: 23, ccsid: 5035, screenSize: "24x80", warn: (w) => log("WARN: " + w) });

let snap = session.snapshot();
const text = (s) => s.cells.map((r) => r.map((c) => c.char).join("").replace(/ +$/u, "")).join("\n");
for (let i = 0; i < 10; i++) {
  const t = text(snap);
  if (t.includes("コマンドを入力") || t.includes("Selection or command")) break;
  const inputs = snap.fields.filter((f) => !f.protected);
  if (t.includes("サイン・オン") || t.includes("Sign On")) {
    if (inputs[0]) session.setField({ index: inputs[0].index }, user);
    if (inputs[1]) session.setField({ index: inputs[1].index }, password);
  } else if (t.includes("回復")) {
    if (inputs[0]) session.setField({ index: inputs[0].index }, "90");
  }
  await session.sendAid("Enter", { timeoutMs: 15000 });
  await new Promise((r) => setTimeout(r, 700));
  snap = session.snapshot();
}

let ok = true;
try {
  log(`build ${LIB}/${fx.dsp} + ${LIB}/${fx.pgm}…`);
  await injectMember(session, DDSF, fx.ddsMbr, fx.ddsAlias, fx.dds);
  await run(session, `DLTF FILE(${LIB}/${fx.dsp})`);
  let s = await run(session, `CRTDSPF FILE(${LIB}/${fx.dsp}) SRCFILE(${LIB}/${DDSF}) SRCMBR(${fx.ddsMbr})`, 30000);
  const dspfOk = /created in library|が作成された|作成されました/i.test(rows(s).join("\n"));
  log(`  CRTDSPF ${fx.dsp}: ${dspfOk ? "OK" : "NG — " + msgOf(s)}`);
  await injectMember(session, RPGF, fx.rpgMbr, fx.rpgAlias, fx.rpg);
  await run(session, `DLTPGM PGM(${LIB}/${fx.pgm})`);
  s = await run(session, `CRTBNDRPG PGM(${LIB}/${fx.pgm}) SRCFILE(${LIB}/${RPGF}) SRCMBR(${fx.rpgMbr})`, 60000);
  let pgmOk = /placed in library|に入れられました|に置かれました/i.test(rows(s).join("\n"));
  if (!pgmOk) {
    // コンパイル進行中のメッセージ（オープン中等）で終わっていることがあるので少し待って再確認
    await new Promise((r) => setTimeout(r, 5000));
    s = session.snapshot();
    pgmOk = /placed in library|に入れられました|に置かれました/i.test(rows(s).join("\n"));
  }
  log(`  CRTBNDRPG ${fx.pgm}: ${pgmOk ? "OK" : "NG — " + msgOf(s)}`);
  ok = dspfOk && pgmOk;
} catch (e) {
  ok = false; log("BUILD ERROR: " + e.message);
} finally {
  await session.disconnect();
}
log(ok ? `OK — ${LIB} に ${fx.dsp}/${fx.pgm} をビルド` : "NG — ビルド失敗");
process.exit(ok ? 0 : 1);
