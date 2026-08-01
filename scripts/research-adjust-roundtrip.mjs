// TESTLIB/ADJPGM へ「左詰めのまま」と「右寄せ済み」の 2 通りで同じ値を送り、
// **ホストが実際に受け取った値**（RPG が `[...]` で囲んで返す）を突き合わせる。
//
// 狙い: 右寄せを端末側でやらないと何が壊れるのかを実測で確かめる。
//   - 英数字欄（CHECK(RZ)/CHECK(RB)）: ホストは整形しない＝端末が右寄せしないと左詰めのまま届くはず
//   - 数値欄: 実測で **DDS の `6 0` も `6S 0` も FFW は signed-num・長さは桁数+1**（符号桁）だった。
//     左詰めのまま送ると数値としてどう解釈されるかが最大の関心事。
//
// 実行: node --env-file=.env scripts/research-adjust-roundtrip.mjs
import { readFileSync } from "node:fs";
import { Session5250 } from "@as400web/tn5250";
import { SecretCrypto } from "../packages/server/dist/secret-crypto.js";

const LIB = "TESTLIB";
const log = (s) => process.stdout.write(s + "\n");
const err = (s) => process.stderr.write(s + "\n");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rows = (s) => s.cells.map((r) => r.map((c) => c.char).join("").replace(/\s+$/, ""));

const NAMES = ["ARZ(RZ,A)", "ARB(RB,A)", "AMF(MF,A)", "AFE(FE,A)", "AME(ME,A)", "APLN(A)", "NRZ(RZ,6 0)", "NPLN(6 0)", "SPLN(6S0)"];
// 左詰め（現状の挙動）と右寄せ済み（実装後に端末が作るはずの形）。
// 数値欄の空白埋めは core の内容検証（/^[0-9.,+-]*$/）に弾かれるためここでは 0 埋めで試す。
const ROUND_A = ["12", "12", "12", "12", "12", "12", "12", "12", "12"];
const ROUND_B = ["000012", "    12", "12", "12", "12", "12", "000012", "000012", "000012"];

async function connectOnce(sys, password, dev) {
  const s = await Session5250.connect({
    host: sys.host, port: sys.port ?? 23, ccsid: sys.ccsid ?? 37, screenSize: "27x132",
    deviceName: dev, user: sys.signon.user, password, warn: (w) => err("WARN: " + w),
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
    } else {
      await s.sendAid("Enter", { timeoutMs: 10000 });
    }
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
    catch (e) { last = e; err(`connect retry ${i + 1} (${dev}): ${e.message}`); await sleep(8000); }
  }
  throw last;
}
async function cmd(session, text, timeoutMs = 30000) {
  const s = session.snapshot();
  const cf = s.fields.filter((f) => !f.protected).slice(-1)[0];
  session.setField({ index: cf.index }, text);
  await session.sendAid("Enter", { cursor: { row: cf.row, col: cf.col }, timeoutMs });
  await sleep(600);
  return session.snapshot();
}

/** ADJPGM の画面で 9 欄へ値を入れて Enter。エコー欄（`[...]`）を読み取って返す */
async function roundTrip(session, values, label) {
  const snap = session.snapshot();
  const inputs = snap.fields.filter((f) => !f.protected);
  if (inputs.length < 9) throw new Error(`入力欄が ${inputs.length} 個しかない（画面が違う）`);
  values.forEach((v, i) => {
    try { session.setField({ index: inputs[i].index }, v); }
    catch (e) { err(`  ${NAMES[i]} に ${JSON.stringify(v)} を入れられない: ${e.code ?? e.message}`); }
  });
  await session.sendAid("Enter", { cursor: { row: inputs[0].row, col: inputs[0].col }, timeoutMs: 20000 });
  await sleep(800);
  const txt = rows(session.snapshot());
  log(`\n---- ${label} ----`);
  NAMES.forEach((nm, i) => {
    const line = txt[2 + i * 2] ?? "";           // DDS は 3 行目から 1 行おき（0 始まりで 2）
    const m = /\[([^\]]*)\]/.exec(line);
    log(`  ${nm.padEnd(12)} 送信=${JSON.stringify(values[i]).padEnd(10)} ホスト受信=${m ? JSON.stringify(m[1]) : "(読めず: " + JSON.stringify(line.slice(0, 60)) + ")"}`);
  });
}

const conns = JSON.parse(readFileSync("connections.json", "utf8"));
const sys = conns.systems.find((s) => s.name === "実機");
const password = SecretCrypto.fromEnv().decrypt(sys.signon.passwordEnc);
const session = await connectHost(sys, password);
try {
  await cmd(session, `ADDLIBLE ${LIB}`);
  await cmd(session, `CALL ${LIB}/ADJPGM`, 30000);
  await roundTrip(session, ROUND_A, "A: 左詰めのまま送る（右寄せ未実装＝現状の挙動）");
  await roundTrip(session, ROUND_B, "B: 右寄せしてから送る（実装後に端末が作る形）");
  await session.sendAid("F3", { timeoutMs: 15000 });
  await sleep(500);
} catch (e) {
  err("ERROR: " + e.message + "\n" + (e.stack ?? ""));
  process.exitCode = 1;
} finally {
  await session.disconnect();
}
