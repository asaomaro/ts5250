// 表示属性 E2E 用のテスト画面を実機（PUB400 等）に作成・コンパイルする。
// <LIB>（既定 MYLIB）に 2 つのフィクスチャを作る:
//   - CLRTDSP/CLRTPGM: フィールド単位の COLOR/DSPATR＋DBCS（日本語）
//   - INLTST/INLPGM  : インライン色制御（フィールドデータ中に属性バイト 0x20-0x3F を埋め込み）
// ソース投入は IFS/FTP 不要で、コマンド行から RUNSQL INSERT（各行を単一 SQL 文字列リテラルで）。
//   - SQL 連結 || は不可（ホストが変体文字 | を認識せず "Token | was not valid"）→ 1 行=1 リテラル。
//   - RUNSQL は COMMIT(*NONE) 必須。CL の引用符二重化＋コマンド行 153 桁制限に収める。
// 冪等（RMVM/ADDPFM/DROP+CREATE ALIAS/DLTF/DLTPGM）。作成後は scripts/verify-attributes.mjs で検証。
// 実行: node --env-file=.env scripts/build-attrtest.mjs
import { Session5250 } from "@ts5250/tn5250";
import { codecForCcsid } from "@ts5250/tn5250/codec";

const LIB = process.env.PUB400_LIB ?? "MYLIB";
const DDSF = "QDDSSRC", RPGF = "QRPGLESRC";
const log = (s) => process.stderr.write(s + "\n");

// --- DDS 行を桁位置で組み立てる ---
const put = (base, pos, str) => { const a = base.split(""); for (let i = 0; i < str.length; i++) a[pos - 1 + i] = str[i]; return a.join(""); };
const blank = () => " ".repeat(80);
const fileKwd = (kw) => put(put(blank(), 6, "A"), 45, kw).replace(/ +$/, "");
const rec = (n) => put(put(put(blank(), 6, "A"), 17, "R"), 19, n).replace(/ +$/, "");
const constant = (r, c, t, kw = "") => put(put(put(put(blank(), 6, "A"), 39, String(r).padStart(3)), 42, String(c).padStart(3)), 45, `'${t}'${kw ? " " + kw : ""}`).replace(/ +$/, "");
function field(name, len, usage, r, c, type = "", dec) {
  let l = put(put(blank(), 6, "A"), 19, name);
  l = put(l, 35 - String(len).length, String(len)); // 30-34 に右詰
  if (type) l = put(l, 35, type);                    // 35=データ型（O=DBCS-open / J=DBCS-only 等）
  if (dec !== undefined) l = put(l, 38 - String(dec).length, String(dec)); // 36-37 小数位（右詰）＝数値欄
  l = put(put(put(l, 38, usage), 39, String(r).padStart(3)), 42, String(c).padStart(3));
  return l.replace(/ +$/, "");
}

// --- フィクスチャ 1: フィールド単位の属性＋DBCS ---
const attr = {
  dsp: "CLRTDSP", pgm: "CLRTPGM", ddsMbr: "CLRTDSP", rpgMbr: "CLRTPGM", ddsAlias: "A1", rpgAlias: "R1",
  dds: [
    fileKwd("DSPSIZ(24 80 *DS3)"), rec("FMT01"), fileKwd("CA03(03)"),
    constant(1, 2, "ATTR TEST"), constant(1, 60, "F3=EXIT"),
    constant(3, 2, "GRN", "COLOR(GRN)"), constant(3, 20, "WHT", "COLOR(WHT)"), constant(3, 40, "RED", "COLOR(RED)"), constant(3, 60, "TRQ", "COLOR(TRQ)"),
    constant(4, 2, "YLW", "COLOR(YLW)"), constant(4, 20, "PNK", "COLOR(PNK)"), constant(4, 40, "BLU", "COLOR(BLU)"),
    constant(6, 2, "RVS", "DSPATR(RI)"), constant(6, 20, "UL", "DSPATR(UL)"), constant(6, 40, "HI", "DSPATR(HI)"),
    constant(7, 2, "BL", "DSPATR(BL)"), constant(7, 20, "CS", "DSPATR(CS)"),
    constant(8, 2, "REDBL", "COLOR(RED) DSPATR(BL)"),
    constant(9, 2, "DBCS:"), field("DBFLD", 12, "O", 9, 8), constant(11, 2, "F3 END")
  ],
  // DBFLD へ SO+日本語+SI(ccsid1399) を出力
  rpg: ["**free", "dcl-f CLRTDSP workstn;", "DBFLD = x'0E4562456648E70F';", "exfmt FMT01;", "*inlr = *on;", "return;"]
};

// --- フィクスチャ 2: インライン色制御（属性バイトをフィールドデータに埋め込む） ---
// CLRLINE = [0x28]RED [0x20]GRN [0x22]WHT [0x38]PNK [0x3A]BLU（属性バイト＋EBCDIC テキスト）
const sbcs = codecForCcsid(37);
const inlineHex = [[0x28, "RED"], [0x20, "GRN"], [0x22, "WHT"], [0x38, "PNK"], [0x3a, "BLU"]]
  .map(([a, t]) => [a, ...sbcs.encode(t).bytes].map((b) => b.toString(16).padStart(2, "0")).join("")).join("").toUpperCase();
const inline = {
  dsp: "INLTST", pgm: "INLPGM", ddsMbr: "INLTST", rpgMbr: "INLPGM", ddsAlias: "I1", rpgAlias: "I2",
  dds: [
    fileKwd("DSPSIZ(24 80 *DS3)"), rec("FMT01"), fileKwd("CA03(03)"),
    constant(1, 2, "INLINE ATTR TEST"), field("CLRLINE", 40, "O", 3, 2), constant(5, 2, "F3 END")
  ],
  rpg: ["**free", "dcl-f INLTST workstn;", `CLRLINE = x'${inlineHex}';`, "exfmt FMT01;", "*inlr = *on;", "return;"]
};

// --- フィクスチャ 3: 入力ラウンドトリップ（SBCS＋DBCS 日本語入力→エコー） ---
// フィールド型ごとの入力ルール検証: 数値(Y)=数字/小数点のみ、A=SBCS のみ(DBCS 不可)、
// O(open)=SBCS+DBCS 両方、J(pure)=DBCS のみ(SBCS 不可)。O/J は入力→エコーで往復も見る。
const input = {
  dsp: "INPTST", pgm: "INPPGM", ddsMbr: "INPTST", rpgMbr: "INPPGM", ddsAlias: "N1", rpgAlias: "N2",
  dds: [
    fileKwd("DSPSIZ(24 80 *DS3)"), rec("FMT01"), fileKwd("CA03(03)"),
    constant(1, 2, "FIELD TYPE TEST  F3=EXIT"),
    constant(3, 2, "NUM:"), field("NUMF", 8, "B", 3, 8, "Y", 2), // 数値（Y=numeric only, 小数2桁）
    constant(4, 2, "A  :"), field("ANAME", 8, "B", 4, 8),        // A（英数字 SBCS）
    constant(5, 2, "O  :"), field("ONAME", 12, "B", 5, 8, "O"),  // O（DBCS-open）
    constant(6, 2, "J  :"), field("JNAME", 12, "B", 6, 8, "J"),  // J（DBCS-only/pure）
    constant(5, 30, "E:"), field("OECHO", 12, "O", 5, 33, "O"),
    constant(6, 30, "E:"), field("JECHO", 12, "O", 6, 33, "O"),
    constant(8, 2, "F3 END")
  ],
  // exfmt→O/J をエコー欄へ複写→再 exfmt（エコー表示）→F3 終了
  rpg: ["**free", "dcl-f INPTST workstn;", "exfmt FMT01;", "OECHO = ONAME;", "JECHO = JNAME;", "exfmt FMT01;", "*inlr = *on;", "return;"]
};

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
async function buildProgram(session, fx) {
  log(`build ${LIB}/${fx.dsp} + ${LIB}/${fx.pgm}…`);
  await injectMember(session, DDSF, fx.ddsMbr, fx.ddsAlias, fx.dds);
  await run(session, `DLTF FILE(${LIB}/${fx.dsp})`);
  let s = await run(session, `CRTDSPF FILE(${LIB}/${fx.dsp}) SRCFILE(${LIB}/${DDSF}) SRCMBR(${fx.ddsMbr})`, 30000);
  const dspfOk = /created in library/i.test(rows(s).join("\n"));
  log(`  CRTDSPF ${fx.dsp}: ${dspfOk ? "OK" : "NG — " + msgOf(s)}`);
  await injectMember(session, RPGF, fx.rpgMbr, fx.rpgAlias, fx.rpg);
  await run(session, `DLTPGM PGM(${LIB}/${fx.pgm})`);
  s = await run(session, `CRTBNDRPG PGM(${LIB}/${fx.pgm}) SRCFILE(${LIB}/${RPGF}) SRCMBR(${fx.rpgMbr})`, 40000);
  const pgmOk = /placed in library/i.test(rows(s).join("\n"));
  log(`  CRTBNDRPG ${fx.pgm}: ${pgmOk ? "OK" : "NG — " + msgOf(s)}`);
  return dspfOk && pgmOk;
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
  ok = (await buildProgram(session, attr)) && ok;
  ok = (await buildProgram(session, inline)) && ok;
  ok = (await buildProgram(session, input)) && ok;
} catch (e) {
  ok = false; log("BUILD ERROR: " + e.message);
} finally {
  await session.disconnect();
}
log(ok ? `OK — ${LIB} に CLRTDSP/CLRTPGM・INLTST/INLPGM・INPTST/INPPGM をビルド（verify-attributes.mjs / verify-input.mjs で検証可）` : "NG — ビルド失敗");
process.exit(ok ? 0 : 1);
