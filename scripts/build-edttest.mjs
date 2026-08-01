// 実機の TESTLIB に **編集コード／編集語つきの入力可能欄**の検証用表示ファイルを作る。
//
// 問い（`.aidev/works/20260729-field-input-open-questions/requirement.md` の U3・U4）:
//   **編集文字（`$` `,` `.` `*` `CR`）を含む値が「入力欄」へ来る構成は実在するか。**
//
// `field-validate.ts` の数値欄の許容集合は `/^[0-9.,+-]*$/` なので、`$1,234.56` のような値は
// 送信時に FIELD_TYPE で拒否される。IBM の仕様上 `EDTCDE` / `EDTWRD` は **output-capable
// フィールド向け**だが、**用途 B（入出力両用）でも書けるのか**を実機のコンパイルで確かめる。
//   - 書けないなら「入力欄に編集文字は来ない」＝許容集合を広げる必要は無い
//   - 書けるなら、ワイヤ上どう来るか（分解されるのか、編集文字ごと 1 欄か）を見る
//
// 1 件ずつ単独でコンパイルして切り分ける（まとめて 1 回だと、どれが落としたか分からない）。
//
// 実行: AS400_PASSWORD=... node scripts/build-edttest.mjs
import { readFileSync } from "node:fs";
import { Session5250 } from "@as400web/tn5250";
import { SecretCrypto } from "../packages/server/dist/secret-crypto.js";

const LIB = "TESTLIB", DDSF = "QDDSSRC", RPGF = "QRPGLESRC";
const log = (s) => process.stdout.write(s + "\n");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rows = (s) => s.cells.map((r) => r.map((c) => c.char).join("").replace(/\s+$/, ""));

const put = (b, p, str) => { const a = b.split(""); for (let i = 0; i < str.length; i++) a[p - 1 + i] = str[i]; return a.join(""); };
const blank = () => " ".repeat(80);
const kwd = (kw) => put(put(blank(), 6, "A"), 45, kw).replace(/ +$/, "");
const rec = (n) => put(put(put(blank(), 6, "A"), 17, "R"), 19, n).replace(/ +$/, "");
const constant = (r, c, t) => put(put(put(put(blank(), 6, "A"), 39, String(r).padStart(3)), 42, String(c).padStart(3)), 45, `'${t}'`).replace(/ +$/, "");
/** 数値欄（小数位 36-37 桁）。`kw` は 45 桁のキーワード */
function numf(name, len, dec, usage, r, c, kw = "", type = "") {
  let l = put(put(blank(), 6, "A"), 19, name);
  l = put(l, 35 - String(len).length, String(len));
  if (type) l = put(l, 35, type);
  l = put(l, 38 - String(dec).length, String(dec));
  l = put(put(put(l, 38, usage), 39, String(r).padStart(3)), 42, String(c).padStart(3));
  if (kw) l = put(l, 45, kw);
  return l.replace(/ +$/, "");
}

/** 検証したい構成。`risky` はコンパイルが通らない可能性があるもの */
const CASES = [
  { nm: "ECB", lab: "EDTCDE(1) B", mk: (r) => [numf("ECB", 6, 2, "B", r, 22, "EDTCDE(1)")] },
  { nm: "EWB", lab: "EDTWRD B", mk: (r) => [numf("EWB", 6, 2, "B", r, 22, "EDTWRD('    ,   . ')")] },
  { nm: "ECJ", lab: "EDTCDE(J) B", mk: (r) => [numf("ECJ", 6, 2, "B", r, 22, "EDTCDE(J)")] },
  { nm: "ECO", lab: "EDTCDE(1) O", mk: (r) => [numf("ECO", 6, 2, "O", r, 22, "EDTCDE(1)")] },
  { nm: "PLN", lab: "plain 6 2 B", mk: (r) => [numf("PLN", 6, 2, "B", r, 22)] }
];

function ddsFor(cases) {
  const body = [rec("EDTR"), kwd("CA03(03)"), constant(1, 3, "EDIT CODE / WORD TEST"), constant(1, 45, "F3=exit")];
  cases.forEach((c, i) => {
    const r = 3 + i * 2;
    body.push(constant(r, 3, c.lab.padEnd(14)));
    body.push(...c.mk(r));
  });
  return body;
}
const ddsOne = (c) => [rec("EDTR"), kwd("CA03(03)"), ...c.mk(3)];

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
    deviceName: dev, user: sys.signon.user, password, warn: () => {}
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
    if (txt.some((r) => r.includes("選択項目またはコマンド") || r.includes("メインメニュー"))) return s;
    if (txt.some((r) => r.includes("対話式ジョブの回復"))) {
      const f = snap.fields.filter((x) => !x.protected).slice(-1)[0];
      s.setField({ index: f.index }, "90");
      await s.sendAid("Enter", { cursor: { row: f.row, col: f.col }, timeoutMs: 12000 });
    } else await s.sendAid("Enter", { timeoutMs: 10000 });
    await sleep(1000);
  }
  s.disconnect();
  throw new Error("no command screen");
}
async function connectHost(sys, password) {
  const pool = ["WEBSF0", "WEBSF1", "WEBSF2", "WEBSF3", "WEBSF4"];
  let last;
  for (let i = 0; i < 12; i++) {
    const dev = pool[i % pool.length];
    try { return await connectOnce(sys, password, dev); }
    catch (e) { last = e; process.stderr.write(`connect retry ${i + 1} (${dev}): ${e.message}\n`); await sleep(7000); }
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

  async function tryCompile(dds, note) {
    await injectMember(session, DDSF, "EDTDSPF", "EDTDA", dds);
    await run(session, `DLTF FILE(${LIB}/EDTDSPF)`);
    const s = await run(session, `CRTDSPF FILE(${LIB}/EDTDSPF) SRCFILE(${LIB}/${DDSF}) SRCMBR(EDTDSPF) GENLVL(29)`, 60000);
    const msg = rows(s).slice(-3).map((x) => x.trim()).filter(Boolean).join(" / ");
    const ok = /作成された|created/i.test(msg);
    log(`  ${note.padEnd(16)} : ${ok ? "OK（コンパイルが通る）" : "NG（この構成は書けない）"}`);
    if (!ok) log(`      ${msg.slice(-120)}`);
    return ok;
  }

  log("########## 単独コンパイル（どの構成が書けるか） ##########");
  const okCases = [];
  for (const c of CASES) if (await tryCompile(ddsOne(c), c.lab)) okCases.push(c);
  log(`\n【結果】書ける: ${okCases.map((c) => c.lab).join(" / ") || "なし"}`);
  log(`【結果】書けない: ${CASES.filter((c) => !okCases.includes(c)).map((c) => c.lab).join(" / ") || "なし"}`);

  if (okCases.length === 0) throw new Error("通る構成が 1 つも無い");
  log("\n########## 通った構成を 1 レコードに束ねる ##########");
  if (!(await tryCompile(ddsFor(okCases), "まとめ"))) failed++;

  // RPG は exfmt して受け取った値を出力欄へ写す（入力可能欄だけ）
  const inputCases = okCases.filter((c) => c.lab.endsWith(" B"));
  const RPG = [
    "**free",
    "dcl-f EDTDSPF workstn;",
    "dou *in03;",
    "  exfmt EDTR;",
    "enddo;",
    "*inlr = *on;",
    "return;"
  ];
  log(`（入力可能な構成 ${inputCases.length} 件: ${inputCases.map((c) => c.lab).join(", ") || "なし"}）`);
  await injectMember(session, RPGF, "EDTPGM", "EDTRA", RPG);
  await run(session, `DLTPGM PGM(${LIB}/EDTPGM)`);
  const s = await run(session, `CRTBNDRPG PGM(${LIB}/EDTPGM) SRCFILE(${LIB}/${RPGF}) SRCMBR(EDTPGM)`, 60000);
  const m = rows(s).slice(-2).map((x) => x.trim()).filter(Boolean).join(" / ");
  log("CRTBNDRPG: " + m.slice(-90));
  if (!/入れられました|created/i.test(m)) failed++;
} catch (e) {
  log("BUILD ERROR: " + e.message);
  failed++;
} finally {
  await session.disconnect();
}
process.exit(failed === 0 ? 0 : 1);
