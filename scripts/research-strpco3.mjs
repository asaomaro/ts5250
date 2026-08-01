// 調査ラウンド 3: テスト用 CL（TESTLIB/PCOTEST・PCOLONG）を実行し、
//   (1) 200 文字コマンドがデータストリーム上でどう並ぶか
//   (2) エミュレーターが実行キーを返したあと CL が STRPCCMD の**先へ進む**か（データ域 PCOMARK）
// を実測する。実行: node --env-file=.env scripts/research-strpco3.mjs [出力先]
import { readFileSync, writeFileSync } from "node:fs";
import { Session5250, CommandConnection } from "@as400web/tn5250";
import { SecretCrypto } from "../packages/server/dist/secret-crypto.js";

const LIB = "TESTLIB";
const OUT = process.argv[2] ?? "/tmp/strpco-cap3.txt";
const log = (s) => process.stderr.write(s + "\n");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rows = (s) => s.cells.map((r) => r.map((c) => c.char).join("").replace(/\s+$/, ""));

const captured = [];
let label = "connect";
const warn = (w) => (w.startsWith("rx record") ? captured.push({ label, line: w }) : log("WARN: " + w));

const conns = JSON.parse(readFileSync("connections.json", "utf8"));
const sys = conns.systems.find((s) => s.name === "実機");
const password = SecretCrypto.fromEnv().decrypt(sys.signon.passwordEnc);
const auth = { host: sys.host, user: sys.signon.user, password, ccsid: sys.ccsid ?? 37 };

async function connectOnce(dev) {
  const s = await Session5250.connect({
    host: sys.host, port: sys.port ?? 23, ccsid: sys.ccsid ?? 37, screenSize: "27x132",
    deviceName: dev, user: sys.signon.user, password, warn, traceRecords: true,
  });
  await sleep(1500);
  const inputs = s.snapshot().fields.filter((f) => !f.protected);
  s.setField({ index: inputs[0].index }, sys.signon.user);
  s.setField({ index: inputs[1].index }, password);
  await s.sendAid("Enter", { cursor: { row: inputs[0].row, col: inputs[0].col }, timeoutMs: 15000 });
  await sleep(800);
  for (let i = 0; i < 8; i++) {
    const snap = s.snapshot(), txt = rows(snap);
    if (txt.some((r) => r.includes("メインメニュー"))) return s;
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
async function connectHost() {
  const pool = ["WEBSF0", "WEBSF1", "WEBSF2", "WEBSF3", "WEBSF4"];
  let last;
  for (let i = 0; i < 10; i++) {
    try { return await connectOnce(pool[i % pool.length]); }
    catch (e) { last = e; log(`retry ${i + 1}: ${e.message}`); await sleep(8000); }
  }
  throw last;
}

const cn = await CommandConnection.connect({ ...auth, resolvePort: true, timeoutMs: 40_000 });
const session = await connectHost();
async function run(cmd, timeoutMs = 25000) {
  const s = session.snapshot();
  const cf = s.fields.filter((f) => !f.protected).slice(-1)[0];
  session.setField({ index: cf.index }, cmd);
  const r = await session.sendAid("Enter", { cursor: { row: cf.row, col: cf.col }, timeoutMs });
  await sleep(700);
  return r;
}
const mark = async () => {
  const r = await cn.run(`DSPDTAARA DTAARA(${LIB}/PCOMARK)`);
  return (r.messages ?? []).map((m) => m.text).join(" ");
};

const notes = [];
try {
  // (1) 123 文字コマンド（1 行の桁数を越えて折り返す）と 200 文字（宣言長超えの確認）
  for (const pgm of ["PCO123"]) {
    label = pgm;
    await run(`CALL TESTLIB/${pgm}`, 30000);
    notes.push(`${pgm}: ${rows(session.snapshot()).filter(Boolean).slice(-2).join(" | ")}`);
    await session.sendAid("Enter", { timeoutMs: 15000 });
    await sleep(700);
  }

  // (2) PAUSE(*YES) で PCOTEST を実行し、実行キー応答のあと CL が先へ進むか
  label = "PCOTEST-YES";
  await cn.run(`CHGDTAARA DTAARA(${LIB}/PCOCMD) VALUE('echo HELLO-FROM-HOST')`);
  await cn.run(`CHGDTAARA DTAARA(${LIB}/PCOWAIT) VALUE('*YES')`);
  await cn.run(`CHGDTAARA DTAARA(${LIB}/PCOMARK) VALUE('INIT      ')`);
  await run("CALL TESTLIB/PCOTEST", 30000);
  notes.push(`PCOTEST(*YES) 応答前の PCOMARK: ${await mark()}`);
  const r2 = await session.sendAid("Enter", { timeoutMs: 15000 });
  await sleep(1200);
  notes.push(`PCOTEST(*YES) 実行キー後の PCOMARK: ${await mark()}`);
  notes.push(`PCOTEST(*YES) 実行キー後の画面末尾: ${rows(r2.screen).filter(Boolean).slice(-2).join(" | ")}`);
} finally {
  writeFileSync(OUT, [...notes, "", ...captured.map((c) => `[${c.label}] ${c.line}`)].join("\n"));
  log(notes.join("\n"));
  log(`wrote ${OUT} (${captured.length} records)`);
  session.disconnect();
  cn.close();
}
