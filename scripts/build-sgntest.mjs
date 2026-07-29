// 実機の TESTLIB に **符号付き数値の送信表現と Dup** の検証用表示ファイル／RPG を作る。
//
//   SGNDSPF/SGNPGM — 符号付き数値（`6S 0`）・ゾーン数値（`6 0`）・数値のみ文字（`6M`）・
//                    `DUP` キーワード付き英数字欄を並べ、`exfmt` の後に**ホストが受け取った値**を
//                    `[...]` で囲んで出力欄へ写す。
//
// 狙い（`.aidev/works/20260729-field-sign-dup-keys/requirement.md` の U1・U2・U4）:
//   (1) いまの実装が送る `-12`（先頭に符号）をホストは**負値として受け取るか**
//   (2) 原典どおりの `    12-`（**最終桁が符号桁**）ならどうか
//   (3) `DUP` は DDS のキーワードとして通るか。通ったら Dup 文字（0x1C）が届くか
//       （RPG 側で `x'1C1C1C1C1C1C'` と突き合わせて `[ALLDUP]` を返す）
//
// 実行: AS400_PASSWORD=... node scripts/build-sgntest.mjs
import { readFileSync } from "node:fs";
import { Session5250 } from "@as400web/core";
import { SecretCrypto } from "../packages/server/dist/secret-crypto.js";

const LIB = "TESTLIB", DDSF = "QDDSSRC", RPGF = "QRPGLESRC";
const log = (s) => process.stderr.write(s + "\n");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rows = (s) => s.cells.map((r) => r.map((c) => c.char).join("").replace(/\s+$/, ""));

// ---- DDS 桁組み立て（build-adjtest.mjs と同じ規則）----
const put = (b, p, str) => { const a = b.split(""); for (let i = 0; i < str.length; i++) a[p - 1 + i] = str[i]; return a.join(""); };
const blank = () => " ".repeat(80);
const kwd = (kw) => put(put(blank(), 6, "A"), 45, kw).replace(/ +$/, "");
const rec = (n) => put(put(put(blank(), 6, "A"), 17, "R"), 19, n).replace(/ +$/, "");
const constant = (r, c, t) => put(put(put(put(blank(), 6, "A"), 39, String(r).padStart(3)), 42, String(c).padStart(3)), 45, `'${t}'`).replace(/ +$/, "");
/** 文字欄（35 桁がシフト・小数位は空白） */
function field(name, len, shift, usage, r, c, kw = "") {
  let l = put(put(blank(), 6, "A"), 19, name);
  l = put(l, 35 - String(len).length, String(len));
  if (shift) l = put(l, 35, shift);
  l = put(put(put(l, 38, usage), 39, String(r).padStart(3)), 42, String(c).padStart(3));
  if (kw) l = put(l, 45, kw);
  return l.replace(/ +$/, "");
}
/** 数値欄（小数位 36-37 桁）。`type` に S を渡すと符号付き */
function numf(name, len, dec, usage, r, c, type = "") {
  let l = put(put(blank(), 6, "A"), 19, name);
  l = put(l, 35 - String(len).length, String(len));
  if (type) l = put(l, 35, type);
  l = put(l, 38 - String(dec).length, String(dec));
  l = put(put(put(l, 38, usage), 39, String(r).padStart(3)), 42, String(c).padStart(3));
  return l.replace(/ +$/, "");
}

function ddsFor({ dup }) {
  const body = [
    rec("SGNR"), kwd("CA03(03)"),
    constant(1, 3, "SIGN / DUP TEST"), constant(1, 40, "F3=exit  Enter=echo"),
    constant(3, 3, "S 6S0 signed "), numf("SGN", 6, 0, "B", 3, 20, "S"), constant(3, 30, "->"), field("ESGN", 14, "A", "O", 3, 34),
    constant(5, 3, "N 6 0 zoned  "), numf("NUM", 6, 0, "B", 5, 20), constant(5, 30, "->"), field("ENUM", 14, "A", "O", 5, 34),
    constant(7, 3, "M 6M  numonly"), field("NMO", 6, "M", "B", 7, 20), constant(7, 30, "->"), field("ENMO", 14, "A", "O", 7, 34),
    constant(9, 3, dup ? "A DUP keyword" : "A plain (noDUP)"), field("DUPF", 6, "A", "B", 9, 20, dup ? "DUP" : ""), constant(9, 30, "->"), field("EDUPF", 14, "A", "O", 9, 34)
  ];
  return body;
}

const RPG = [
  "**free",
  "dcl-f SGNDSPF workstn;",
  "dou *in03;",
  "  exfmt SGNR;",
  "  ESGN = '[' + %char(SGN) + ']';",
  "  ENUM = '[' + %char(NUM) + ']';",
  "  ENMO = '[' + NMO + ']';",
  "  if DUPF = x'1C1C1C1C1C1C';",
  "    EDUPF = '[ALLDUP]';",
  "  else;",
  "    EDUPF = '[' + DUPF + ']';",
  "  endif;",
  "enddo;",
  "*inlr = *on;",
  "return;"
];

// ============ 実行系（build-adjtest.mjs と同方式）============
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
  await run(session, `ADDPFM FILE(${LIB}/${srcf}) MBR(${mbr}) SRCTYPE(${srcf === DDSF ? "DSPF" : "RPGLE"})`);
  await runSql(session, `DROP ALIAS ${LIB}/${alias}`);
  await runSql(session, `CREATE ALIAS ${LIB}/${alias} FOR ${LIB}/${srcf}(${mbr})`);
  for (const l of lines) await run(session, insertSrc(alias, l));
}
async function connectOnce(sys, password, dev) {
  const s = await Session5250.connect({
    host: sys.host, port: sys.port ?? 23, ccsid: sys.ccsid ?? 37, screenSize: "27x132",
    deviceName: dev, user: sys.signon.user, password, warn: (w) => log("WARN: " + w)
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
  log("giving up on: " + rows(s.snapshot()).filter(Boolean).slice(0, 4).join(" | ").slice(0, 300));
  s.disconnect();
  throw new Error("no command screen");
}
async function connectHost(sys, password) {
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
let failed = 0;
try {
  await run(session, `ADDLIBLE ${LIB}`);
  await run(session, `CRTSRCPF FILE(${LIB}/${DDSF}) RCDLEN(92)`);
  await run(session, `CRTSRCPF FILE(${LIB}/${RPGF}) RCDLEN(92)`);

  async function tryCompile(opts, note) {
    const dds = ddsFor(opts);
    log(`\n--- CRTDSPF (${note}) DDS lines=${dds.length} ---`);
    await injectMember(session, DDSF, "SGNDSPF", "SGNDA", dds);
    await run(session, `DLTF FILE(${LIB}/SGNDSPF)`);
    const s = await run(session, `CRTDSPF FILE(${LIB}/SGNDSPF) SRCFILE(${LIB}/${DDSF}) SRCMBR(SGNDSPF) GENLVL(29)`, 60000);
    const msg = rows(s).slice(-3).map((x) => x.trim()).filter(Boolean).join(" / ");
    const ok = /作成された|created/i.test(msg);
    log(`CRTDSPF ${ok ? "OK" : "**NG**"}: ${msg}`);
    return ok;
  }

  // `DUP` は DDS のキーワードとして通るか。通らなければ「その名前ではない」という事実が得られる
  let ok = await tryCompile({ dup: true }, "DUP キーワードあり");
  if (ok) log("【DUP_ENABLE】DDS の `DUP` キーワードは通った");
  else {
    log("【DUP_ENABLE】**DDS の `DUP` は通らない** → DUP_ENABLE を立てる指定ではない");
    ok = await tryCompile({ dup: false }, "DUP キーワードなし");
  }
  if (!ok) failed++;

  await injectMember(session, RPGF, "SGNPGM", "SGNRA", RPG);
  await run(session, `DLTPGM PGM(${LIB}/SGNPGM)`);
  const s = await run(session, `CRTBNDRPG PGM(${LIB}/SGNPGM) SRCFILE(${LIB}/${RPGF}) SRCMBR(SGNPGM)`, 60000);
  const m = rows(s).slice(-2).map((x) => x.trim()).filter(Boolean).join(" / ");
  log("CRTBNDRPG: " + m);
  if (!/入れられました|created/i.test(m)) failed++;
} catch (e) {
  log("BUILD ERROR: " + e.message + "\n" + (e.stack ?? ""));
  failed++;
} finally {
  await session.disconnect();
}
process.exit(failed === 0 ? 0 : 1);
