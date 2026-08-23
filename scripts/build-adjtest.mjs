// 実機の TESTLIB に FFW の ADJUST（右寄せ）検証用の表示ファイル／RPG を作成・コンパイルする。
//
//   ADJDSPF/ADJPGM — CHECK(RZ)/CHECK(RB)/CHECK(MF)/CHECK(FE)/CHECK(ME) と、素の英数字欄・
//                    ゾーン数値欄・符号付き数値欄（S）を 1 レコードに並べる。exfmt のあと
//                    受け取った値を `[...]` で囲んだ出力欄へ写すので、**ホストが実際に受け取った
//                    桁揃え**が画面から読める（前後の空白が見える）。
//
// **右寄せは端末側の仕事**（原典: GNU tn5250 `display.c` の `tn5250_display_field_adjust` /
// tn5250j `Screen5250#fieldExit`）。ホストは FFW に指定を載せるだけなので、まず実機が
// そのビットを立てて送ってくるかを確かめる必要がある（→ research-adjust.mjs）。
//
// 実行: node --env-file=.env --env-file=.env.verify scripts/build-adjtest.mjs
import { readFileSync } from "node:fs";
import { Session5250 } from "@ts5250/tn5250";
import { SecretCrypto } from "../packages/server/dist/secret-crypto.js";

const LIB = process.env.AS400_LIB ?? "TESTLIB", DDSF = "QDDSSRC", RPGF = "QRPGLESRC";
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

/**
 * 検証対象の欄。`kw` が FFW へ載る指定、`echo` は受信値を写す出力欄。
 * **CHECK(RZ)/CHECK(RB) は英数字欄にも指定できる**かをこのコンパイルで確かめる
 * （落ちたら数値欄だけに絞る）。
 */
const CASES = [
  { nm: "ARZ", lab: "CHECK(RZ) A", kw: "CHECK(RZ)", kind: "A" },
  { nm: "ARB", lab: "CHECK(RB) A", kw: "CHECK(RB)", kind: "A" },
  { nm: "AMF", lab: "CHECK(MF) A", kw: "CHECK(MF)", kind: "A" },
  { nm: "AFE", lab: "CHECK(FE) A", kw: "CHECK(FE)", kind: "A" },
  { nm: "AME", lab: "CHECK(ME) A", kw: "CHECK(ME)", kind: "A" },
  { nm: "APLN", lab: "plain    A", kw: "", kind: "A" },
  { nm: "NRZ", lab: "CHECK(RZ) 6 0", kw: "CHECK(RZ)", kind: "N" },
  { nm: "NPLN", lab: "plain    6 0", kw: "", kind: "N" },
  { nm: "SPLN", lab: "signed   6S0", kw: "", kind: "S" },
];

const body = [rec("ADJR"), kwd("CA03(03)"), constant(1, 3, "FFW ADJUST TEST"), constant(1, 40, "F3=exit  Enter=echo")];
CASES.forEach((c, i) => {
  const r = 3 + i * 2;
  body.push(constant(r, 3, c.lab.padEnd(14)));
  if (c.kind === "A") body.push(field(c.nm, 6, "A", "B", r, 20, c.kw));
  else if (c.kind === "N") body.push(numf(c.nm, 6, 0, "B", r, 20, c.kw));
  else body.push(numf(c.nm, 6, 0, "B", r, 20, c.kw, "S"));
  body.push(constant(r, 30, "->"));
  body.push(field("E" + c.nm, 10, "A", "O", r, 34));
});
const DDS = body;

// ---- RPGLE: 受け取った値を `[...]` で囲んで写す（前後の空白を目で確かめられるように）----
const RPG = [
  "**free",
  "dcl-f ADJDSPF workstn;",
  "dou *in03;",
  "  exfmt ADJR;",
  ...CASES.map((c) =>
    c.kind === "A"
      ? `  E${c.nm} = '[' + ${c.nm} + ']';`
      : `  E${c.nm} = '[' + %char(${c.nm}) + ']';`
  ),
  "enddo;",
  "*inlr = *on;",
  "return;",
];

// ============ 実行系（build-feat.mjs と同方式）============
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
const sys = conns.systems.find((s) => s.name === (process.env.AS400_SYSTEM ?? "AS400"));
const password = SecretCrypto.fromEnv().decrypt(sys.signon.passwordEnc);
const session = await connectHost(sys, password);
let failed = 0;
try {
  await run(session, `ADDLIBLE ${LIB}`);
  await run(session, `CRTSRCPF FILE(${LIB}/${DDSF}) RCDLEN(92)`);
  await run(session, `CRTSRCPF FILE(${LIB}/${RPGF}) RCDLEN(92)`);
  log(`DDS lines=${DDS.length}, RPG lines=${RPG.length}`);
  await injectMember(session, DDSF, "ADJDSPF", "ADJDA", DDS);
  await run(session, `DLTF FILE(${LIB}/ADJDSPF)`);
  let s = await run(session, `CRTDSPF FILE(${LIB}/ADJDSPF) SRCFILE(${LIB}/${DDSF}) SRCMBR(ADJDSPF) GENLVL(29)`, 40000);
  const m1 = rows(s).slice(-2).map((x) => x.trim()).filter(Boolean).join(" / ");
  log("CRTDSPF: " + m1);
  if (!/作成された|created/i.test(m1)) failed++;
  await injectMember(session, RPGF, "ADJPGM", "ADJRA", RPG);
  await run(session, `DLTPGM PGM(${LIB}/ADJPGM)`);
  s = await run(session, `CRTBNDRPG PGM(${LIB}/ADJPGM) SRCFILE(${LIB}/${RPGF}) SRCMBR(ADJPGM)`, 60000);
  const m2 = rows(s).slice(-2).map((x) => x.trim()).filter(Boolean).join(" / ");
  log("CRTBNDRPG: " + m2);
  if (!/入れられました|created/i.test(m2)) failed++;
} catch (e) {
  log("BUILD ERROR: " + e.message + "\n" + (e.stack ?? ""));
  failed++;
} finally {
  await session.disconnect();
}
process.exit(failed === 0 ? 0 : 1);
