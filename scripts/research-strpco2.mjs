// 調査ラウンド 2: STRPCO のパラメーター（F4 プロンプト）と、PC Organizer 関連コマンドの実在確認。
// 実行: node --env-file=.env scripts/research-strpco2.mjs
import { readFileSync, writeFileSync } from "node:fs";
import { Session5250, DbConnection, query } from "@as400web/tn5250";
import { SecretCrypto } from "../packages/server/dist/secret-crypto.js";

const OUT = process.argv[2] ?? "/tmp/strpco-research2.txt";
const log = (s) => process.stderr.write(s + "\n");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rows = (s) => s.cells.map((r) => r.map((c) => c.char).join("").replace(/\s+$/, ""));

const conns = JSON.parse(readFileSync("connections.json", "utf8"));
const sys = conns.systems.find((s) => s.name === "実機");
const password = SecretCrypto.fromEnv().decrypt(sys.signon.passwordEnc);
const out = [];

// ---- 1) SQL: QSYS の PC Organizer 系コマンドを列挙 ----
try {
  const db = await DbConnection.connect({
    host: sys.host, user: sys.signon.user, password, ccsid: sys.ccsid ?? 37,
  });
  try {
    const sql =
      "SELECT OBJNAME, OBJTEXT FROM TABLE(QSYS2.OBJECT_STATISTICS('QSYS','CMD')) X " +
      "WHERE OBJNAME LIKE '%PC%' ORDER BY OBJNAME";
    const r = await query(db, sql);
    out.push("=== QSYS *CMD LIKE %PC% ===");
    for (const row of r.rows) out.push(`${String(row.OBJNAME).trim().padEnd(12)} ${String(row.OBJTEXT ?? "").trim()}`);
  } finally { db.close(); }
} catch (e) {
  out.push(`SQL failed: ${e.message}`);
  log("SQL failed: " + e.message);
}

// ---- 2) 5250: STRPCO を F4 でプロンプトしてパラメーターを見る ----
async function connectOnce(dev) {
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

const session = await connectHost();
async function typeAndKey(cmd, key) {
  const s = session.snapshot();
  const cf = s.fields.filter((f) => !f.protected).slice(-1)[0];
  session.setField({ index: cf.index }, cmd);
  await session.sendAid(key, { cursor: { row: cf.row, col: cf.col }, timeoutMs: 20000 });
  await sleep(700);
  return session.snapshot();
}
try {
  for (const cmd of ["STRPCO", "STRPCCMD"]) {
    const snap = await typeAndKey(cmd, "F4");
    out.push(`\n=== F4 prompt: ${cmd} ===`, ...rows(snap));
    await session.sendAid("F3", { timeoutMs: 15000 });
    await sleep(700);
    await session.sendAid("F3", { timeoutMs: 10000 }).catch(() => {});
    await sleep(500);
  }
} finally {
  writeFileSync(OUT, out.join("\n"));
  log(`wrote ${OUT}`);
  session.disconnect();
}
