// 実機の TESTLIB に「複雑な表示機能テスト画面」を作成・コンパイル・実行する。
//   FEATDSPF/FEATPGM: EDTCDE / EDTWRD / 文字色(COLOR) / 背景色(COLOR+DSPATR(RI)) /
//   DSPATR 各種 / CNTFLD(継続入力欄の行あふれ) / DBCS 分断 を 3 画面で網羅。
// 実行: node --env-file=.env --env-file=.env.verify scripts/build-feat.mjs
import { readFileSync } from "node:fs";
import { Session5250 } from "@ts5250/tn5250";
import { codecForCcsid } from "@ts5250/tn5250/codec";
import { SecretCrypto } from "../packages/server/dist/secret-crypto.js";

const LIB = process.env.AS400_LIB ?? "TESTLIB", DDSF = "QDDSSRC", RPGF = "QRPGLESRC";
const log = (s) => process.stderr.write(s + "\n");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rows = (s) => s.cells.map((r) => r.map((c) => c.char).join("").replace(/\s+$/, ""));
const cp939 = codecForCcsid(939);
const hx = (jp) => Array.from(cp939.encode(jp).bytes).map((b) => b.toString(16).padStart(2, "0")).join("").toUpperCase();

// ---- DDS 桁組み立て ----
const put = (b, p, str) => { const a = b.split(""); for (let i = 0; i < str.length; i++) a[p - 1 + i] = str[i]; return a.join(""); };
const blank = () => " ".repeat(80);
const kwd = (kw) => put(put(blank(), 6, "A"), 45, kw).replace(/ +$/, "");
const rec = (n) => put(put(put(blank(), 6, "A"), 17, "R"), 19, n).replace(/ +$/, "");
const constant = (r, c, t, kw = "") => put(put(put(put(blank(), 6, "A"), 39, String(r).padStart(3)), 42, String(c).padStart(3)), 45, `'${t}'${kw ? " " + kw : ""}`).replace(/ +$/, "");
function field(name, len, type, usage, r, c, kw = "") {
  let l = put(put(blank(), 6, "A"), 19, name);
  l = put(l, 35 - String(len).length, String(len));
  if (type) l = put(l, 35, type);
  l = put(put(put(l, 38, usage), 39, String(r).padStart(3)), 42, String(c).padStart(3));
  if (kw) l = put(l, 45, kw);
  return l.replace(/ +$/, "");
}
function numf(name, len, dec, usage, r, c, kw = "") {
  let l = put(put(blank(), 6, "A"), 19, name);
  l = put(l, 35 - String(len).length, String(len));      // 桁数 30-34
  l = put(l, 38 - String(dec).length, String(dec));      // 小数 36-37
  l = put(put(put(l, 38, usage), 39, String(r).padStart(3)), 42, String(c).padStart(3));
  if (kw) l = put(l, 45, kw);
  return l.replace(/ +$/, "");
}

// ============ 画面定義 ============
const rpgAssign = [];   // RPG の代入行を集める

// ---- SCRN1: EDTCDE / EDTWRD ----
const EDTCODES = ["1", "2", "3", "4", "A", "B", "C", "D", "J", "K", "L", "M"];
const scrn1 = [
  rec("SCRN1"), kwd("CA03(03)"),
  constant(1, 3, "EDTCDE -1234567.89"), constant(1, 40, "Enter=next  F3=exit"),
  constant(3, 3, "CODE          OUTPUT"),
];
EDTCODES.forEach((code, i) => {
  const nm = "E" + code, r = 4 + i;
  scrn1.push(constant(r, 3, `EDTCDE(${code})`));
  scrn1.push(numf(nm, 9, 2, "O", r, 18, `EDTCDE(${code})`));
  rpgAssign.push(`${nm} = -1234567.89;`);
});
scrn1.push(constant(16, 3, "EDTCDE(Y)"), numf("EY", 6, 0, "O", 16, 18, "EDTCDE(Y)"));
scrn1.push(constant(17, 3, "EDTCDE(Z)"), numf("EZ", 7, 0, "O", 17, 18, "EDTCDE(Z)"));
scrn1.push(constant(18, 3, "no edit  "), numf("ERAW", 7, 0, "O", 18, 18));
rpgAssign.push("EY = 123124;", "EZ = 1234;", "ERAW = 1234;");
// EDTWRD（右側）
scrn1.push(constant(3, 55, "EDTWRD TEST"));
const WRD = [
  { nm: "WPHONE", len: 7, wrd: "   -    ", val: 1234567, lab: "PHONE" },
  { nm: "WTIME", len: 6, wrd: "  :  :  ", val: 123456, lab: "TIME " },
  { nm: "WZERO", len: 7, wrd: "0000000", val: 123, lab: "ZFILL" },
];
WRD.forEach((w, i) => {
  const r = 5 + i;
  scrn1.push(constant(r, 55, w.lab + ":"));
  scrn1.push(numf(w.nm, w.len, 0, "O", r, 63, `EDTWRD('${w.wrd}')`));
  rpgAssign.push(`${w.nm} = ${w.val};`);
});

// ---- SCRN2: 文字色 / 背景色 / DSPATR ----
const COLORS = ["GRN", "WHT", "RED", "TRQ", "YLW", "PNK", "BLU"];
const scrn2 = [
  rec("SCRN2"), kwd("CA03(03)"),
  constant(1, 3, "COLOR / BG / DSPATR TEST"), constant(1, 40, "Enter=next  F3=exit"),
  constant(3, 2, "CHAR COLOR"),
  constant(3, 25, "BG=COLOR+RI"),
  constant(3, 48, "DSPATR"),
];
COLORS.forEach((c, i) => {
  const r = 5 + i;
  scrn2.push(constant(r, 2, `${c} text`, `COLOR(${c})`));
  scrn2.push(constant(r, 25, `${c}`, `COLOR(${c}) DSPATR(RI)`));
});
[["RI", "reverse"], ["HI", "bright"], ["UL", "underln"], ["BL", "blink"], ["CS", "colsep"], ["ND", "hidden"]]
  .forEach(([a, t], i) => scrn2.push(constant(5 + i, 48, `${a} ${t}`, `DSPATR(${a})`)));

// ---- SCRN3: CNTFLD / DBCS 分断 ----
const scrn3 = [
  rec("SCRN3"), kwd("CA03(03)"),
  constant(1, 3, "CNTFLD + DBCS SPLIT TEST"), constant(1, 40, "Enter=next  F3=exit"),
  constant(3, 3, "CNTFLD(30) len90 fill50"), constant(3, 40, "wrap every 30 cols:"),
  field("CFLD1", 90, "A", "B", 5, 5, "CNTFLD(30)"),
  constant(11, 3, "DBCS SO+aiueo+SI=12B"), constant(11, 40, "truncated by O-width:"),
];
[12, 11, 10, 9, 8, 7, 6].forEach((w, i) => {
  const r = 13 + i, nm = "OW" + w;
  scrn3.push(constant(r, 3, `O width ${String(w).padStart(2)} :`));
  scrn3.push(field(nm, w, "O", "O", r, 18));
  rpgAssign.push(`${nm} = dbsrc;`);
});
rpgAssign.push("CFLD1 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789abcdefghijkl';");

const DDS = [
  ...scrn1, ...scrn2, ...scrn3,   // DSPSIZ 省略（既定 24x80 *DS3。この機は DSPSIZ 指定を CPD7520 で弾く）
];

// ---- RPGLE ----
const RPG = [
  "**free",
  "dcl-f FEATDSPF workstn;",
  "dcl-s dbsrc char(12);",
  `dbsrc = x'${hx("あいうえお")}';`,
  ...rpgAssign,
  "exfmt SCRN1;",
  "exfmt SCRN2;",
  "exfmt SCRN3;",
  "*inlr = *on;",
  "return;",
];

// ============ 実行系（build-empsfl と同方式） ============
async function run(session, cmd, timeoutMs = 30000) {
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
  for (const l of lines) {
    const cmd = insertSrc(alias, l);
    const bytes = cp939.encode(cmd).bytes.length;
    if (bytes > 153) { log(`SKIP too long (${bytes}B): ${l}`); continue; }
    await run(session, cmd);
  }
}
async function connectOnce(sys, password, dev) {
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
  for (let i = 0; i < 8; i++) {
    const snap = s.snapshot();
    const txt = rows(snap);
    if (txt.some((r) => r.includes("メインメニュー"))) { log(`command screen (dev=${dev})`); return s; }
    if (txt.some((r) => r.includes("対話式ジョブの回復"))) {
      // 90=前の対話式ジョブのサイン・オフ（中断ジョブを片付ける）
      const f = snap.fields.filter((x) => !x.protected).slice(-1)[0];
      s.setField({ index: f.index }, "90");
      await s.sendAid("Enter", { cursor: { row: f.row, col: f.col }, timeoutMs: 12000 });
    } else {
      await s.sendAid("Enter", { timeoutMs: 10000 });
    }
    await sleep(1000);
  }
  s.disconnect();
  throw new Error("no command screen");
}
async function connectHost(sys, password) {
  // 既存装置名を再利用（新規ユニーク名は QAUTOVRT 上限に当たり negotiation で切られる）
  const pool = ["WEBSF0", "WEBSF1", "WEBSF2", "WEBSF3", "WEBSF4"];
  let last;
  for (let i = 0; i < 10; i++) {
    const dev = pool[i % pool.length];
    try { return await connectOnce(sys, password, dev); }
    catch (e) { last = e; log(`connect retry ${i + 1} (${dev}): ${e.message}`); await sleep(8000); }
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
  await injectMember(session, DDSF, "FEATDSPF", "FEATDA", DDS);
  await run(session, `DLTF FILE(${LIB}/FEATDSPF)`);
  let s = await run(session, `CRTDSPF FILE(${LIB}/FEATDSPF) SRCFILE(${LIB}/${DDSF}) SRCMBR(FEATDSPF) GENLVL(29)`, 40000);
  log("CRTDSPF: " + rows(s).slice(-2).map((x) => x.trim()).filter(Boolean).join(" / "));
  await injectMember(session, RPGF, "FEATPGM", "FEATRA", RPG);
  await run(session, `DLTPGM PGM(${LIB}/FEATPGM)`);
  s = await run(session, `CRTBNDRPG PGM(${LIB}/FEATPGM) SRCFILE(${LIB}/${RPGF}) SRCMBR(FEATPGM)`, 60000);
  log("CRTBNDRPG: " + rows(s).slice(-2).map((x) => x.trim()).filter(Boolean).join(" / "));
} catch (e) {
  log("BUILD ERROR: " + e.message + "\n" + (e.stack ?? ""));
} finally {
  await session.disconnect();
}
