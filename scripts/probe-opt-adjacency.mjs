// 「入力欄の右隣 1 桁は必ず空くのか」を DSPF で実地検証する。
//
// 5250 の SF オーダーは属性バイトを**欄の手前の桁**に置く（buffer.ts addField の
// 「attrByte は startAddr-1」）。ならば欄と欄の間には最低 1 桁の隙間が要るはずだが、
// 「必ず空地」までは protocol が保証していない——閉じ属性を送らないアプリがある
// （buffer.ts:819 が PDM を名指しで対処）。そこで DSPF を実際に作って確かめる。
//
// 検証する 4 行:
//   r8  OPT1(2桁,c2) と OPT2(2桁,c4)   … 隙間なし。**コンパイルが通るか**
//   r10 OPT3(2桁,c2) と OPT4(2桁,c5)   … 隙間 1 桁。c4 は何になるか
//   r12 OPT5(2桁,c2) と 定数 'X'(c4)   … 定数が隣接できるか
//   r14 OPT6(2桁,c2) のみ              … 右隣は閉じ属性か素の空白か
//
// 実行: AS400_PASSWORD=... node scripts/probe-opt-adjacency.mjs
import { readFileSync } from "node:fs";
import { Session5250 } from "@as400web/core";
import { SecretCrypto } from "../packages/server/dist/secret-crypto.js";

const LIB = "TESTLIB", DDSF = "QDDSSRC", RPGF = "QRPGLESRC";
const log = (s) => process.stderr.write(s + "\n");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rows = (s) => s.cells.map((r) => r.map((c) => c.char).join("").replace(/\s+$/, ""));

// ---- DDS 桁組み立て（build-feat.mjs と同じ規則）----
const put = (b, p, str) => { const a = b.split(""); for (let i = 0; i < str.length; i++) a[p - 1 + i] = str[i]; return a.join(""); };
const blank = () => " ".repeat(80);
const kwd = (kw) => put(put(blank(), 6, "A"), 45, kw).replace(/ +$/, "");
const rec = (n) => put(put(put(blank(), 6, "A"), 17, "R"), 19, n).replace(/ +$/, "");
const constant = (r, c, t, kw = "") => put(put(put(put(blank(), 6, "A"), 39, String(r).padStart(3)), 42, String(c).padStart(3)), 45, `'${t}'${kw ? " " + kw : ""}`).replace(/ +$/, "");
/** 英数字欄（type=A/O/J、省略可）。長さは 30-34 桁・型 35 桁・用途 38 桁 */
function field(name, len, type, usage, r, c, kw = "") {
  let l = put(put(blank(), 6, "A"), 19, name);
  l = put(l, 35 - String(len).length, String(len));
  if (type) l = put(l, 35, type);
  l = put(put(put(l, 38, usage), 39, String(r).padStart(3)), 42, String(c).padStart(3));
  if (kw) l = put(l, 45, kw);
  return l.replace(/ +$/, "");
}
/** 数値欄。type を渡すと符号付き（S）等になる。小数位は 36-37 桁 */
function numf(name, len, dec, usage, r, c, kw = "", type = "") {
  let l = put(put(blank(), 6, "A"), 19, name);
  l = put(l, 35 - String(len).length, String(len));
  if (type) l = put(l, 35, type);
  l = put(l, 38 - String(dec).length, String(dec));
  l = put(put(put(l, 38, usage), 39, String(r).padStart(3)), 42, String(c).padStart(3));
  if (kw) l = put(l, 45, kw);
  return l.replace(/ +$/, "");
}

const DDS = [
  put(put(blank(), 6, "A"), 45, "DSPSIZ(24 80)").replace(/ +$/, ""),
  rec("OPTTEST"),
  kwd("CA03(03)"),
  constant(2, 2, "OPT ADJACENCY TEST"),
  constant(8, 20, "r8: gap 0 (c2+c4)"),
  field("OPT1", 2, "A", "B", 8, 2),
  field("OPT2", 2, "A", "B", 8, 4),
  constant(10, 20, "r10: gap 1 (c2+c5)"),
  field("OPT3", 2, "A", "B", 10, 2),
  field("OPT4", 2, "A", "B", 10, 5),
  constant(12, 20, "r12: field + const at c4"),
  field("OPT5", 2, "A", "B", 12, 2),
  constant(12, 4, "X"),
  constant(14, 20, "r14: field only"),
  field("OPT6", 2, "A", "B", 14, 2)
];
/** r8 を外した版（隙間 0 が通らなかったときの再試行） */
const DDS_NOGAP0 = DDS.filter((l) => !/OPT1|OPT2|gap 0/.test(l));

const RPG = [
  "**FREE",
  "DCL-F OPTDSPF WORKSTN;",
  "EXFMT OPTTEST;",
  "*INLR = *ON;"
];
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
  for (const l of lines) await run(session, insertSrc(alias, l));
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
    // コマンド画面の判定は**2 通りの文言**で見る（メニュー名は導線で変わるが、
    // 入力プロンプトの見出しは共通。build-empsfl.mjs と同じ判定）
    if (txt.some((r) => r.includes("選択項目またはコマンド") || r.includes("メインメニュー"))) {
      log(`command screen (dev=${dev})`);
      return s;
    }
    if (txt.some((r) => r.includes("対話式ジョブの回復"))) {
      const f = snap.fields.filter((x) => !x.protected).slice(-1)[0];
      s.setField({ index: f.index }, "90");
      await s.sendAid("Enter", { cursor: { row: f.row, col: f.col }, timeoutMs: 12000 });
    } else {
      await s.sendAid("Enter", { timeoutMs: 10000 });
    }
    await sleep(1000);
  }
  // 何の画面で止まったかを残す（推測で直さないため）
  log("giving up on: " + rows(s.snapshot()).filter(Boolean).slice(0, 4).join(" | ").slice(0, 300));
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
const sys = conns.systems.find((s) => s.name === "実機");
const password = process.env.AS400_PASSWORD ?? SecretCrypto.fromEnv().decrypt(sys.signon.passwordEnc);
const session = await connectHost(sys, password);
try {
  await run(session, `ADDLIBLE ${LIB}`);
  await run(session, `CRTSRCPF FILE(${LIB}/${DDSF}) RCDLEN(92)`);
  await run(session, `CRTSRCPF FILE(${LIB}/${RPGF}) RCDLEN(92)`);

  // --- 1) 隙間 0 を含む版でコンパイルできるか ---
  await injectMember(session, DDSF, "OPTDSPF", "OPTDA", DDS);
  await run(session, `DLTF FILE(${LIB}/OPTDSPF)`);
  let s = await run(session, `CRTDSPF FILE(${LIB}/OPTDSPF) SRCFILE(${LIB}/${DDSF}) SRCMBR(OPTDSPF) GENLVL(29)`, 60000);
  const msg1 = rows(s).slice(-3).map((x) => x.trim()).filter(Boolean).join(" / ");
  const ok1 = /作成された|created/i.test(msg1);
  log(`\n【1】隙間 0（c2 と c4 に 2 桁欄）: ${ok1 ? "コンパイル成功" : "**コンパイル失敗**"}`);
  log("    " + msg1);

  if (!ok1) {
    log("    → 隙間 0 は DDS が受け付けない。r8 を外して残りを検証する");
    await injectMember(session, DDSF, "OPTDSPF", "OPTDA", DDS_NOGAP0);
    await run(session, `DLTF FILE(${LIB}/OPTDSPF)`);
    s = await run(session, `CRTDSPF FILE(${LIB}/OPTDSPF) SRCFILE(${LIB}/${DDSF}) SRCMBR(OPTDSPF) GENLVL(29)`, 60000);
    log("    再コンパイル: " + rows(s).slice(-2).map((x) => x.trim()).filter(Boolean).join(" / "));
  }

  await injectMember(session, RPGF, "OPTPGM", "OPTRA", RPG);
  await run(session, `DLTPGM PGM(${LIB}/OPTPGM)`);
  s = await run(session, `CRTBNDRPG PGM(${LIB}/OPTPGM) SRCFILE(${LIB}/${RPGF}) SRCMBR(OPTPGM)`, 60000);
  log("CRTBNDRPG: " + rows(s).slice(-2).map((x) => x.trim()).filter(Boolean).join(" / "));

  // --- 2) 実際に表示して右隣の桁を見る ---
  await run(session, `CALL ${LIB}/OPTPGM`);
  await sleep(1500);
  const snap = session.snapshot();
  log("\n【2】表示された画面（先頭 16 行）:");
  rows(snap).slice(0, 16).forEach((l, i) => l.trim() && log(`  r${String(i + 1).padStart(2)}|${l}|`));

  log("\n【3】入力欄と、その右隣の桁:");
  for (const f of snap.fields.filter((x) => !x.protected).sort((a, b) => a.row - b.row || a.col - b.col)) {
    const right = f.col + f.length;
    const cell = snap.cells[f.row - 1]?.[right - 1];
    const ch = cell?.char === "" ? "(tail)" : JSON.stringify(cell?.char ?? null);
    log(`  欄 r${f.row} c${f.col} len${f.length} → 右隣 c${right}: kind=${cell?.kind} char=${ch}`);
  }
  await session.sendAid("F3", { timeoutMs: 15000 });
} catch (e) {
  log("ERR " + (e?.stack ?? e));
} finally {
  session.disconnect?.();
  process.exit(0);
}
