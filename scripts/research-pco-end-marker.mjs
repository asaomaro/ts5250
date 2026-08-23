// **PCO 終了標識 `27 00 FC D7 C3 D6 40 83 80 82 00` を実機に出させる**試み
// （backlog `pc-command.md`）。
//
// 値は xtn5250 の `ENDSTRPCCMD` 定数から採ったもので、**実機で見たことがない**。
// `20260728-strpco-strpccmd` D6 は「実機に `ENDPCO` が無く誘発できなかった」で止めた。
//
// 2026-08-22 に前提を測り直した:
//
//   - `ENDPCO` は **7.3 / 7.5 のどちらにも無い**（`CHKOBJ` で `CPF9801`）
//   - `STRPCO` は両機に在り、パラメータは **`PCTA(*YES|*NO)` の 1 つだけ**
//     （`retrieveCommandTemplate` で確認）。**終了指定は無い**
//
// つまりホスト側のコマンドで終わらせる道は無い。残る可能性は「PCO を起動した状態で
// **セッション側が終わる**とき、ホストが終了標識を送るか」なので、そこを見る:
//
//   1. `STRPCO` で開始
//   2. `STRPCO` を**もう一度**（起動し直しで終了標識が出るか）
//   3. `STRPCO PCTA(*NO)` に切り替える
//   4. `SIGNOFF` する
//
// **どの段でも出なければ、それ自体が結論**——「ホスト側からは誘発できない」を
// 推測ではなく測定で言えるようにする。
//
// 実行: node --env-file=.env scripts/research-pco-end-marker.mjs [出力先]
import { readFileSync, writeFileSync } from "node:fs";
import { Session5250 } from "@ts5250/tn5250";
import { SecretCrypto } from "../packages/server/dist/secret-crypto.js";

const OUT = process.argv[2] ?? "/tmp/pco-end-capture.txt";
const log = (s) => process.stderr.write(s + "\n");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rows = (s) => s.cells.map((r) => r.map((c) => c.char).join("").replace(/\s+$/u, ""));

/** 16 進文字列にする。**手で書き写さない**（1 桁ずれても「出なかった」に見えてしまう） */
const hexOf = (bytes) => bytes.map((b) => b.toString(16).padStart(2, "0")).join("");
/** 探している標識（属性込み 11 バイト。`packages/tn5250` の `PCO_END` と同じ並び） */
const PCO_END_HEX = hexOf([0x27, 0x00, 0xfc, 0xd7, 0xc3, 0xd6, 0x40, 0x83, 0x80, 0x82, 0x00]);
/** 開始標識。**出ることが分かっている方**——捕捉が効いていることの対照に使う */
const PCO_START_HEX = hexOf([0x27, 0x80, 0xfc, 0xd7, 0xc3, 0xd6, 0x40, 0x83, 0x80, 0xa1, 0x80]);

const captured = [];
let label = "connect";
function warn(w) {
  if (w.startsWith("rx record")) captured.push({ label, line: w });
  else log("WARN: " + w);
}

// **置き場が 2 つある**（個人設定 / サーバー設定）。片方だけ見ると設定を移した日に黙って落ちる
const sys = (() => {
  for (const f of ["profiles.local.json", "connections.json"]) {
    try {
      const hit = JSON.parse(readFileSync(f, "utf8")).systems?.find((x) => x.name === "実機");
      if (hit) return hit;
    } catch { /* 無ければ次 */ }
  }
  return undefined;
})();
if (!sys) {
  log("実機の定義が profiles.local.json / connections.json のどちらにもありません");
  process.exit(1);
}
const password = process.env.AS400_PASSWORD ?? SecretCrypto.fromEnv().decrypt(sys.signon.passwordEnc);

async function run(session, cmd, timeoutMs = 25000) {
  const s = session.snapshot();
  const cf = s.fields.filter((f) => !f.protected).slice(-1)[0];
  if (!cf) throw new Error("no input field for command");
  session.setField({ index: cf.index }, cmd);
  const r = await session.sendAid("Enter", { cursor: { row: cf.row, col: cf.col }, timeoutMs });
  await sleep(700);
  return { snap: session.snapshot(), timedOut: r.timedOut };
}

async function connectOnce(dev) {
  const s = await Session5250.connect({
    host: sys.host, port: sys.port ?? 23, ccsid: sys.ccsid ?? 37, screenSize: "27x132",
    deviceName: dev, user: sys.signon.user, password, warn, traceRecords: true
  });
  await sleep(1500);
  const inputs = s.snapshot().fields.filter((f) => !f.protected);
  s.setField({ index: inputs[0].index }, sys.signon.user);
  s.setField({ index: inputs[1].index }, password);
  await s.sendAid("Enter", { cursor: { row: inputs[0].row, col: inputs[0].col }, timeoutMs: 15000 });
  await sleep(800);
  for (let i = 0; i < 8; i++) {
    const txt = rows(s.snapshot());
    if (txt.some((r) => r.includes("メインメニュー") || r.includes("MAIN"))) return s;
    if (txt.some((r) => r.includes("対話式ジョブの回復"))) {
      const f = s.snapshot().fields.filter((x) => !x.protected).slice(-1)[0];
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

async function connect() {
  // 既存装置名を再利用（新規名は自動構成が効かず negotiation で切られる。scripts/README.md）
  const pool = (process.env.PCO_DEVNAMES ?? "WEBSF0,WEBSF1,WEBSF2,WEBSF3,WEBSF4").split(",");
  let last;
  for (let i = 0; i < 10; i++) {
    const dev = pool[i % pool.length];
    try { return await connectOnce(dev); } catch (e) {
      last = e;
      log(`connect retry ${i + 1} (${dev}): ${e.message}`);
      await sleep(8000);
    }
  }
  throw last;
}

const steps = [];
const record = (name, snap, timedOut) => {
  const txt = rows(snap);
  steps.push({ name, timedOut, screen: txt });
  log(`--- ${name} (timedOut=${timedOut}) ---`);
  log(txt.filter((r) => r.trim()).slice(0, 4).join("\n"));
};

const session = await connect();
try {
  for (const [name, cmd] of [
    ["1-STRPCO", "STRPCO"],
    ["2-STRPCO-again", "STRPCO"],
    ["3-STRPCO-PCTA-NO", "STRPCO PCTA(*NO)"],
    ["4-SIGNOFF", "SIGNOFF"]
  ]) {
    label = name;
    try {
      const { snap, timedOut } = await run(session, cmd);
      record(name, snap, timedOut);
    } catch (e) {
      log(`  ${name}: ${e.message}`);
      break; // SIGNOFF は切断するので、ここで終わるのが正常
    }
    await sleep(1200);
  }
} finally {
  try { session.disconnect(); } catch { /* 良い */ }
  const hex = captured.map((c) => `${c.label}: ${c.line}`).join("\n");
  const found = (h) => captured.filter((c) => c.line.replace(/\s/gu, "").includes(h));
  const end = found(PCO_END_HEX);
  const start = found(PCO_START_HEX);
  const summary = [
    "=== 結論 ===",
    `終了標識 ${PCO_END_HEX}: ${end.length ? `**出た** (${end.map((e) => e.label).join(", ")})` : "出なかった"}`,
    `開始標識 ${PCO_START_HEX}: ${start.length ? `出た (${start.map((e) => e.label).join(", ")})` : "出なかった（捕捉自体が効いていない可能性あり）"}`,
    `捕捉レコード数: ${captured.length}`,
    "",
    "=== SCREENS ===",
    ...steps.map((s) => `--- ${s.name} (timedOut=${s.timedOut}) ---\n${s.screen.filter((r) => r.trim()).join("\n")}`),
    "",
    "=== RAW ===",
    hex
  ].join("\n");
  writeFileSync(OUT, summary);
  log(`\n${summary.split("=== SCREENS ===")[0]}`);
  log(`（全文: ${OUT}）`);
}
