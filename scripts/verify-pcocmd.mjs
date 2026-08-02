// PC コマンド（STRPCO / STRPCCMD）の実機検証（実機）。
//
// ホスト側のテスト CL `TESTLIB/PCOTEST`（`scripts/build-pcotest.mjs` で作成）が
// データ域 PCOCMD / PCOWAIT を読んで STRPCO → STRPCCMD を実行する。
// こちらは core の検出（`Session5250.onPcCommand`）と server の実行（`runPcCommand`）を
// 実際に繋いで、**ファイルが作られたか**で判定する
// ——ホストは実行の有無を検証しないので「ホストが進んだ」だけでは実行できた証拠にならない（research D5）。
//
// 実行: node --env-file=.env scripts/verify-pcocmd.mjs
import { readFileSync, existsSync, rmSync } from "node:fs";
import { Session5250, CommandConnection } from "@ts5250/tn5250";
import { runPcCommand } from "../packages/server/dist/pc-command.js";
import { SecretCrypto } from "../packages/server/dist/secret-crypto.js";

const LIB = "TESTLIB";
const log = (s) => process.stderr.write(s + "\n");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rows = (s) => s.cells.map((r) => r.map((c) => c.char).join("").replace(/\s+$/, ""));

let pass = 0, fail = 0;
const check = (ok, name, detail = "") => {
  if (ok) { pass++; log(`PASS  ${name}`); }
  else { fail++; log(`FAIL  ${name}${detail ? " — " + detail : ""}`); }
};

const conns = JSON.parse(readFileSync("connections.json", "utf8"));
const sys = conns.systems.find((s) => s.name === "実機");
if (!sys) { log("connections.json に実機がない"); process.exit(1); }
const password = SecretCrypto.fromEnv().decrypt(sys.signon.passwordEnc);
const auth = { host: sys.host, user: sys.signon.user, password, ccsid: sys.ccsid ?? 37 };

const cn = await CommandConnection.connect({ ...auth, resolvePort: true, timeoutMs: 40_000 });

// ---- 5250 セッション（装置名は使い回す。新規名は自動構成が効かない。scripts/README.md）----
const POOL = ["WEBSF0", "WEBSF1", "WEBSF2", "WEBSF3", "WEBSF4"];
let poolIndex = 0;

async function connectOnce(dev, onPcCommand) {
  const s = await Session5250.connect({
    host: sys.host, port: sys.port ?? 23, ccsid: sys.ccsid ?? 37, screenSize: "27x132",
    deviceName: dev, user: sys.signon.user, password, onPcCommand,
    warn: (w) => log("  WARN: " + w),
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

async function connectHost(onPcCommand) {
  let last;
  for (let i = 0; i < 10; i++) {
    const dev = POOL[poolIndex++ % POOL.length];
    try { return await connectOnce(dev, onPcCommand); }
    catch (e) { last = e; log(`  connect retry ${i + 1} (${dev}): ${e.message}`); await sleep(8000); }
  }
  throw last;
}

async function callPcotest(session, timeoutMs) {
  const s = session.snapshot();
  const cf = s.fields.filter((f) => !f.protected).slice(-1)[0];
  session.setField({ index: cf.index }, `CALL ${LIB}/PCOTEST`);
  const r = await session.sendAid("Enter", { cursor: { row: cf.row, col: cf.col }, timeoutMs });
  await sleep(800);
  return { screen: session.snapshot(), timedOut: r.timedOut };
}

/**
 * 1 ケース = 1 セッション。**同じジョブで STRPCO を 2 回実行すると IWS4010 になる**
 * ので使い回さない（research D2）。
 */
async function runCase({ name, command, wait, config, expectFile, expectStatus }) {
  const flag = `/tmp/pcotest-${name}.flag`;
  rmSync(flag, { force: true });
  const seen = [];
  await cn.run(`CHGDTAARA DTAARA(${LIB}/PCOCMD) VALUE('${command.replace(/'/g, "''")}')`);
  await cn.run(`CHGDTAARA DTAARA(${LIB}/PCOWAIT) VALUE('${wait ? "*YES" : "*NO"}')`);

  const session = await connectHost(async (cmd) => {
    const outcome = await runPcCommand(cmd, config);
    seen.push({ cmd, outcome });
  });
  try {
    const { screen, timedOut } = await callPcotest(session, 60_000);
    const text = rows(screen).join("\n");
    check(!timedOut, `${name}: ホスト応答がタイムアウトしない`);
    check(text.includes("PCOTEST DONE"), `${name}: CL が STRPCCMD の先へ進む`, text.split("\n").slice(-2).join(" | "));
    check(seen.length === 1, `${name}: PC コマンドを 1 件検出`, `検出 ${seen.length} 件`);
    if (seen[0]) {
      check(seen[0].cmd.command === command, `${name}: コマンド本文が一致`, `受信 "${seen[0].cmd.command}"`);
      check(seen[0].cmd.wait === wait, `${name}: PAUSE 指定が一致`, `受信 wait=${seen[0].cmd.wait}`);
      check(seen[0].outcome.status === expectStatus, `${name}: 実行結果が ${expectStatus}`,
        JSON.stringify(seen[0].outcome));
    }
    // PAUSE(*NO) は完了を待たないので、ファイル生成まで少し待つ
    if (!wait) await sleep(1500);
    check(existsSync(flag) === expectFile, `${name}: コマンドが${expectFile ? "実行された" : "実行されない"}`,
      `${flag} ${existsSync(flag) ? "あり" : "なし"}`);
  } finally {
    rmSync(flag, { force: true });
    session.disconnect();
    await sleep(1500);
  }
}

try {
  // 1) 有効 + PAUSE(*YES): 完了を待ってから実行キーを返す
  await runCase({
    name: "wait", command: "touch /tmp/pcotest-wait.flag", wait: true,
    config: { enabled: true, timeoutMs: 20000 }, expectFile: true, expectStatus: "ran",
  });
  // 2) 有効 + PAUSE(*NO): 待たずに実行キーを返す
  await runCase({
    name: "nowait", command: "touch /tmp/pcotest-nowait.flag", wait: false,
    config: { enabled: true }, expectFile: true, expectStatus: "started",
  });
  // 3) 無効（既定）: 実行しないが**ホストは進む**（応答は返す）
  await runCase({
    name: "disabled", command: "touch /tmp/pcotest-disabled.flag", wait: true,
    config: undefined, expectFile: false, expectStatus: "disabled",
  });
  // 4) 許可リスト外: 実行しないがホストは進む
  await runCase({
    name: "denied", command: "touch /tmp/pcotest-denied.flag", wait: true,
    config: { enabled: true, allow: ["echo .*"] }, expectFile: false, expectStatus: "denied",
  });
} catch (e) {
  fail++;
  log("ERROR: " + (e?.stack ?? e));
} finally {
  cn.close();
}

log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
