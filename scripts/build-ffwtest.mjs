// 実機の TESTLIB に **FFW の挙動ビット**検証用の表示ファイル／RPG を作成・コンパイルする。
//
//   FFWDSPF/FFWPGM — DDS の**キーボード・シフト**（35 桁: A/X/N/Y/W/D/I/M）と
//                    `CHECK(LC)` / `CHECK(ER)` を 1 レコードに並べる。
//                    値のやり取りは不要（**FFW のビットだけが関心事**）なので、
//                    すべて usage=I（入力のみ）にして RPG は exfmt するだけにする。
//
// 狙い（`.aidev/works/20260729-ffw-behavior-bits/requirement.md` の U1・U2・U4）:
//   (1) シフト種別が本当に FFW の 0x0700 へ載るか（ALPHA_ONLY / KATAKANA / IO の実値）
//   (2) `CHECK(LC)` を書くと MONOCASE（0x0020）が落ちるか
//       ＝素の英数字欄に MONOCASE が立つのは「LC を書いていないから」という読みの確認
//   (3) **AUTO_ENTER（0x0080）を立てる DDS キーワードは何か。** `CHECK(ER)` が候補。
//       コンパイルが通らなければ「その名前ではない」という事実が得られる（推測を残さない）
//
// 前作 `build-adjtest.mjs` と同じ組み立て規則・同じ実行系。
//
// 実行: node --env-file=.env scripts/build-ffwtest.mjs
//   （`.env` が無い場合は AS400_PASSWORD=... を環境変数で渡す。**ファイルには書かない**）
import { readFileSync } from "node:fs";
import { Session5250 } from "@ts5250/tn5250";
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
/** 文字欄。長さは 30-34 桁・型/シフト 35 桁・用途 38 桁（小数位 36-37 は空白のまま） */
function field(name, len, shift, usage, r, c, kw = "") {
  let l = put(put(blank(), 6, "A"), 19, name);
  l = put(l, 35 - String(len).length, String(len));
  if (shift) l = put(l, 35, shift);
  l = put(put(put(l, 38, usage), 39, String(r).padStart(3)), 42, String(c).padStart(3));
  if (kw) l = put(l, 45, kw);
  return l.replace(/ +$/, "");
}

/**
 * 検証対象。`shift` は DDS 35 桁のキーボード・シフト。
 * **`risky` はコンパイルが通らない可能性がある候補**（通らなければ落として再挑戦する）。
 */
const CASES = [
  { nm: "FA", lab: "A  plain", shift: "A", kw: "" },
  { nm: "FALC", lab: "A  CHECK(LC)", shift: "A", kw: "CHECK(LC)" },
  { nm: "FX", lab: "X  alpha-only", shift: "X", kw: "" },
  { nm: "FN", lab: "N  num-shift", shift: "N", kw: "" },
  { nm: "FY", lab: "Y  num-only", shift: "Y", kw: "" },
  { nm: "FW", lab: "W  katakana", shift: "W", kw: "" },
  { nm: "FD", lab: "D  digits-only", shift: "D", kw: "" },
  { nm: "FI", lab: "I  inhibit-kbd", shift: "I", kw: "" },
  { nm: "FM", lab: "M  num-only-char", shift: "M", kw: "" },
  { nm: "FER", lab: "A  CHECK(ER)", shift: "A", kw: "CHECK(ER)", risky: true }
];

function ddsFor(cases) {
  const body = [rec("FFWR"), kwd("CA03(03)"), constant(1, 3, "FFW BEHAVIOR BITS TEST"), constant(1, 40, "F3=exit")];
  cases.forEach((c, i) => {
    const r = 3 + i * 2;
    body.push(constant(r, 3, c.lab.padEnd(16)));
    body.push(field(c.nm, 6, c.shift, "I", r, 22, c.kw));
  });
  return body;
}

/** 1 件だけを載せた最小の DDS（どのケースがコンパイルを落とすかの切り分け用） */
function ddsOne(c) {
  return [rec("FFWR"), kwd("CA03(03)"), field(c.nm, 6, c.shift, "I", 3, 22, c.kw)];
}

// 値は使わない（FFW だけが関心事）ので RPG は exfmt するだけ
const RPG = [
  "**free",
  "dcl-f FFWDSPF workstn;",
  "dou *in03;",
  "  exfmt FFWR;",
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

  /** DDS を入れて CRTDSPF。成功したら true。 */
  async function tryCompile(dds, note) {
    log(`\n--- CRTDSPF (${note}) DDS lines=${dds.length} ---`);
    await injectMember(session, DDSF, "FFWDSPF", "FFWDA", dds);
    await run(session, `DLTF FILE(${LIB}/FFWDSPF)`);
    const s = await run(session, `CRTDSPF FILE(${LIB}/FFWDSPF) SRCFILE(${LIB}/${DDSF}) SRCMBR(FFWDSPF) GENLVL(29)`, 60000);
    const msg = rows(s).slice(-3).map((x) => x.trim()).filter(Boolean).join(" / ");
    const ok = /作成された|created/i.test(msg);
    log(`CRTDSPF ${ok ? "OK" : "**NG**"}: ${msg}`);
    return ok;
  }

  // 1) **1 件ずつ**コンパイルして、どのシフト種別／キーワードが通るかを確かめる。
  //    まとめて 1 回だけ試すと「どれが落としたか」が分からない（最初の試行がそれで無駄になった）。
  log("\n########## 単独コンパイル（通る指定の切り分け） ##########");
  const okCases = [];
  for (const c of CASES) {
    const ok = await tryCompile(ddsOne(c), `単独: ${c.lab}`);
    if (ok) okCases.push(c);
    log(`  => ${c.lab.padEnd(16)} : ${ok ? "OK" : "NG（この指定はこの機では使えない）"}`);
  }
  log(`\n【単独コンパイル結果】OK=${okCases.map((c) => c.lab).join(" / ") || "なし"}`);
  log(`【単独コンパイル結果】NG=${CASES.filter((c) => !okCases.includes(c)).map((c) => c.lab).join(" / ") || "なし"}`);

  // 2) 通ったものだけを 1 レコードに並べて本番の表示ファイルにする
  if (okCases.length === 0) throw new Error("通る指定が 1 つも無い");
  const ok = await tryCompile(ddsFor(okCases), "通った指定を全部");
  if (!ok) failed++;
  log("\n【後続への申し送り】research-ffw.mjs の labels は上の OK 順（" +
    okCases.map((c) => c.lab).join(", ") + "）に対応する");

  await injectMember(session, RPGF, "FFWPGM", "FFWRA", RPG);
  await run(session, `DLTPGM PGM(${LIB}/FFWPGM)`);
  const s = await run(session, `CRTBNDRPG PGM(${LIB}/FFWPGM) SRCFILE(${LIB}/${RPGF}) SRCMBR(FFWPGM)`, 60000);
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
