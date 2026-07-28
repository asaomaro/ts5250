// 実機で STRPCO / STRPCCMD を実行し、ホストが送ってくる 5250 データストリームを
// **生バイトで捕捉**する調査スクリプト（.aidev/works/20260728-strpco-strpccmd/research.md）。
//
// 推測で実装しないための工程（AGENTS.md「既存プロトコル実装の移植」）。
// 実行: node --env-file=.env scripts/research-strpco.mjs [出力先]
import { readFileSync, writeFileSync } from "node:fs";
import { Session5250 } from "@as400web/core";
import { SecretCrypto } from "../packages/server/dist/secret-crypto.js";

const OUT = process.argv[2] ?? "/tmp/strpco-capture.txt";
const log = (s) => process.stderr.write(s + "\n");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rows = (s) => s.cells.map((r) => r.map((c) => c.char).join("").replace(/\s+$/, ""));

// ---- 捕捉バッファ（traceRecords が warn に流す "rx record" 行を拾う） ----
const captured = [];
let label = "connect";
function warn(w) {
  if (w.startsWith("rx record")) captured.push({ label, line: w });
  else log("WARN: " + w);
}

async function run(session, cmd, timeoutMs = 30000) {
  const s = session.snapshot();
  const cf = s.fields.filter((f) => !f.protected).slice(-1)[0];
  if (!cf) throw new Error("no input field for command");
  session.setField({ index: cf.index }, cmd);
  const r = await session.sendAid("Enter", { cursor: { row: cf.row, col: cf.col }, timeoutMs });
  await sleep(700);
  return { snap: session.snapshot(), timedOut: r.timedOut };
}

async function connectOnce(sys, password, dev) {
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
    const snap = s.snapshot();
    const txt = rows(snap);
    if (txt.some((r) => r.includes("メインメニュー"))) { log(`command screen (dev=${dev})`); return s; }
    if (txt.some((r) => r.includes("対話式ジョブの回復"))) {
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
  // 既存装置名を再利用（新規名は自動構成が効かず negotiation で切られる。scripts/README.md）
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
const password = SecretCrypto.fromEnv().decrypt(sys.signon.passwordEnc);
const session = await connectHost(sys, password);

const steps = [];
function record(name, snap, timedOut) {
  const txt = rows(snap);
  steps.push({ name, timedOut, screen: txt });
  log(`--- ${name} (timedOut=${timedOut}) ---`);
  log(txt.slice(0, 8).join("\n"));
  log(`  [msg] ${snap.systemMessage ?? ""}`);
}

try {
  // 1) STRPCO — PC Organizer 開始。ホストが何を送ってくるかを見る
  label = "STRPCO";
  {
    const { snap, timedOut } = await run(session, "STRPCO", 25000);
    record("STRPCO", snap, timedOut);
  }
  // 応答を要求されているかもしれないので Enter を 1 回
  label = "STRPCO-enter";
  {
    const r = await session.sendAid("Enter", { timeoutMs: 15000 });
    record("STRPCO-enter", r.screen, r.timedOut);
  }

  // 2) STRPCCMD PAUSE(*NO)
  label = "STRPCCMD-NO";
  {
    const { snap, timedOut } = await run(session, "STRPCCMD PCCMD('echo NOWAIT') PAUSE(*NO)", 25000);
    record("STRPCCMD-NO", snap, timedOut);
  }
  label = "STRPCCMD-NO-enter";
  {
    const r = await session.sendAid("Enter", { timeoutMs: 15000 });
    record("STRPCCMD-NO-enter", r.screen, r.timedOut);
  }

  // 3) STRPCCMD PAUSE(*YES)
  label = "STRPCCMD-YES";
  {
    const { snap, timedOut } = await run(session, "STRPCCMD PCCMD('echo WAITME') PAUSE(*YES)", 25000);
    record("STRPCCMD-YES", snap, timedOut);
  }
  label = "STRPCCMD-YES-enter";
  {
    const r = await session.sendAid("Enter", { timeoutMs: 15000 });
    record("STRPCCMD-YES-enter", r.screen, r.timedOut);
  }

  // 4) ENDPCO — 終了マーカーを見る
  label = "ENDPCO";
  {
    const { snap, timedOut } = await run(session, "ENDPCO", 25000);
    record("ENDPCO", snap, timedOut);
  }
  label = "ENDPCO-enter";
  {
    const r = await session.sendAid("Enter", { timeoutMs: 15000 });
    record("ENDPCO-enter", r.screen, r.timedOut);
  }
} finally {
  const body = [
    "=== SCREENS ===",
    ...steps.map((s) => `--- ${s.name} (timedOut=${s.timedOut}) ---\n${s.screen.join("\n")}`),
    "",
    "=== RECORDS ===",
    ...captured.map((c) => `[${c.label}] ${c.line}`),
  ].join("\n");
  writeFileSync(OUT, body);
  log(`wrote ${OUT} (${captured.length} records)`);
  session.disconnect();
}
