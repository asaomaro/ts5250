// 実機の TESTLIB に「拡張5250(GUI) 要素テスト画面」を作成・コンパイルする。
//   EXTDSPF/EXTPGM: SNGCHCFLD(ラジオ) / MLTCHCFLD(チェックボックス) / PSHBTNFLD(ボタン) /
//   WINDOW(ポップアップ) を Enhanced 5250 で描く。enhanced=true のセッションで撮影する。
// 実行: node --env-file=.env --env-file=.env.verify scripts/build-ext.mjs
import { readFileSync } from "node:fs";
import { Session5250 } from "@ts5250/tn5250";
import { SecretCrypto } from "../packages/server/dist/secret-crypto.js";

const LIB = process.env.AS400_LIB ?? "TESTLIB", DDSF = "QDDSSRC", RPGF = "QRPGLESRC";
const log = (s) => process.stderr.write(s + "\n");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rows = (s) => s.cells.map((r) => r.map((c) => c.char).join("").replace(/\s+$/, ""));

const put = (b, p, str) => { const a = b.split(""); for (let i = 0; i < str.length; i++) a[p - 1 + i] = str[i]; return a.join(""); };
const blank = () => " ".repeat(80);
const kwd = (kw) => put(put(blank(), 6, "A"), 45, kw).replace(/ +$/, "");
const condKwd = (ind, kw) => put(put(put(blank(), 6, "A"), 9, String(ind)), 45, kw).replace(/ +$/, "");
const rec = (n) => put(put(put(blank(), 6, "A"), 17, "R"), 19, n).replace(/ +$/, "");
const constant = (r, c, t, kw = "") => put(put(put(put(blank(), 6, "A"), 39, String(r).padStart(3)), 42, String(c).padStart(3)), 45, `'${t}'${kw ? " " + kw : ""}`).replace(/ +$/, "");
function fld(name, len, type, dec, usage, r, c, kw = "") {
  let l = put(put(blank(), 6, "A"), 19, name);
  l = put(l, 35 - String(len).length, String(len));
  if (type) l = put(l, 35, type);
  if (dec !== "" && dec !== undefined) l = put(l, 38 - String(dec).length, String(dec));
  l = put(put(put(l, 38, usage), 39, String(r).padStart(3)), 42, String(c).padStart(3));
  if (kw) l = put(l, 45, kw);
  return l.replace(/ +$/, "");
}

// ---- DDS ----
// 拡張5250 で確実に描ける要素: サブファイルのスクロールバー と WINDOW ポップアップ。
const DDS = [
  // サブファイル（enhanced ではスクロールバーが付く）
  rec("EXTSFL"), kwd("SFL"),
  fld("SLINE", 50, "", "", "O", 6, 4),
  rec("EXTCTL"), kwd("SFLCTL(EXTSFL)"),
  kwd("SFLSIZ(0030)"), kwd("SFLPAG(0010)"), kwd("OVERLAY"),
  condKwd(31, "SFLDSP"), condKwd(32, "SFLDSPCTL"), condKwd(33, "SFLCLR"),
  condKwd(34, "SFLEND(*SCRBAR)"),
  kwd("CA03(03)"),
  constant(1, 3, "ENHANCED: scrollbar"), constant(1, 45, "Enter=next F3=exit"),
  constant(3, 3, "Scroll with scrollbar:"),
  // WINDOW ポップアップ
  rec("EXTWIN"), kwd("WINDOW(6 18 10 46)"), kwd("WDWTITLE((*TEXT 'Window'))"), kwd("CA12(12)"),
  constant(2, 2, "GUI popup (WINDOW)."),
  constant(4, 2, "Name:"), fld("WNAME", 12, "", "", "B", 4, 9),
  constant(6, 2, "City:"), fld("WCITY", 12, "", "", "B", 6, 9),
  constant(8, 2, "Enter=OK   F12=Cancel"),
];

// ---- RPGLE ----
const RPG = [
  "**free",
  "dcl-f EXTDSPF workstn sfile(EXTSFL:rrn);",
  "dcl-s rrn packed(4:0);",
  "dcl-s i int(5);",
  "*in33 = *on;",
  "write EXTCTL;",
  "*in33 = *off;",
  "for i = 1 to 30;",
  "  SLINE = 'Row ' + %char(i) + ' scrollable line';",
  "  rrn += 1;",
  "  write EXTSFL;",
  "endfor;",
  "*in31 = *on;",
  "*in32 = *on;",
  "*in34 = *on;",
  "exfmt EXTCTL;",
  "WNAME = 'USER';",
  "exfmt EXTWIN;",
  "*inlr = *on;",
  "return;",
];

// ---- 実行系 ----
async function run(session, cmd, timeoutMs = 40000) {
  const s = session.snapshot();
  const cf = s.fields.filter((f) => !f.protected).slice(-1)[0];
  session.setField({ index: cf.index }, cmd);
  await session.sendAid("Enter", { cursor: { row: cf.row, col: cf.col }, timeoutMs });
  await sleep(500);
  return session.snapshot();
}
const runSql = (session, sql) => run(session, `RUNSQL SQL('${sql.replace(/'/g, "''")}') COMMIT(*NONE)`);
function insertSrc(alias, line) {
  const sql = `INSERT INTO ${LIB}/${alias} (SRCDTA) VALUES('${line.replace(/'/g, "''")}')`;
  return `RUNSQL SQL('${sql.replace(/'/g, "''")}') COMMIT(*NONE)`;
}
async function injectMember(session, srcf, mbr, alias, lines) {
  await run(session, `RMVM FILE(${LIB}/${srcf}) MBR(${mbr})`);
  await run(session, `ADDPFM FILE(${LIB}/${srcf}) MBR(${mbr})`);
  await runSql(session, `DROP ALIAS ${LIB}/${alias}`);
  await runSql(session, `CREATE ALIAS ${LIB}/${alias} FOR ${LIB}/${srcf}(${mbr})`);
  for (const l of lines) { const cmd = insertSrc(alias, l); if (cmd.length > 300) throw new Error("too long: " + l); await run(session, cmd); }
}
async function connectOnce(sys, password, dev) {
  const s = await Session5250.connect({ host: sys.host, port: sys.port ?? 23, ccsid: sys.ccsid ?? 37, screenSize: "27x132", deviceName: dev, user: sys.signon.user, password, warn: (w) => log("WARN: " + w) });
  await sleep(1500);
  for (let i = 0; i < 12; i++) {
    const snap = s.snapshot(), txt = rows(snap);
    if (txt.some((r) => r.includes("メインメニュー"))) { log(`command screen (dev=${dev})`); return s; }
    const inputs = snap.fields.filter((f) => !f.protected);
    if (txt.some((r) => r.includes("サイン") && r.includes("オン")) && inputs.length >= 2) {
      s.setField({ index: inputs[0].index }, sys.signon.user);
      s.setField({ index: inputs[1].index }, password);
      await s.sendAid("Enter", { cursor: { row: inputs[0].row, col: inputs[0].col }, timeoutMs: 15000 });
    } else if (txt.some((r) => r.includes("対話式ジョブの回復"))) {
      const f = inputs.slice(-1)[0]; s.setField({ index: f.index }, "90"); await s.sendAid("Enter", { cursor: { row: f.row, col: f.col }, timeoutMs: 12000 });
    } else {
      await s.sendAid("Enter", { timeoutMs: 10000 });
    }
    await sleep(1100);
  }
  s.disconnect();
  throw new Error("no command screen");
}
async function connectHost(sys, password) {
  const pool = ["WEBSF0", "WEBSF1", "WEBSF2", "WEBSF3", "WEBSF4"];
  let last;
  for (let i = 0; i < 10; i++) {
    try { return await connectOnce(sys, password, pool[i % pool.length]); }
    catch (e) { last = e; log(`connect retry ${i + 1}: ${e.message}`); await sleep(8000); }
  }
  throw last;
}

const conns = JSON.parse(readFileSync("connections.json", "utf8"));
const sys = conns.systems.find((s) => s.name === (process.env.AS400_SYSTEM ?? "AS400"));
const password = SecretCrypto.fromEnv().decrypt(sys.signon.passwordEnc);
const session = await connectHost(sys, password);
try {
  await run(session, `ADDLIBLE ${LIB}`);
  await run(session, `CRTSRCPF FILE(${LIB}/${DDSF}) RCDLEN(92)`);
  await run(session, `CRTSRCPF FILE(${LIB}/${RPGF}) RCDLEN(92)`);
  log(`DDS lines=${DDS.length}, RPG lines=${RPG.length}`);
  await injectMember(session, DDSF, "EXTDSPF", "EXTDA", DDS);
  await run(session, `DLTF FILE(${LIB}/EXTDSPF)`);
  let s = await run(session, `CRTDSPF FILE(${LIB}/EXTDSPF) SRCFILE(${LIB}/${DDSF}) SRCMBR(EXTDSPF)`, 40000);
  log("CRTDSPF: " + rows(s).filter((r) => /EXTDSPF|エラー|作成/.test(r)).slice(-2).join(" / "));
  await injectMember(session, RPGF, "EXTPGM", "EXTRA", RPG);
  await run(session, `DLTPGM PGM(${LIB}/EXTPGM)`);
  s = await run(session, `CRTBNDRPG PGM(${LIB}/EXTPGM) SRCFILE(${LIB}/${RPGF}) SRCMBR(EXTPGM)`, 60000);
  log("CRTBNDRPG: " + rows(s).filter((r) => /EXTPGM|エラー|入れられ|コンパイル/.test(r)).slice(-2).join(" / "));
} catch (e) {
  log("BUILD ERROR: " + e.message);
} finally {
  await session.disconnect();
}
