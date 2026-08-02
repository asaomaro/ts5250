// 実機で **編集コード／編集語つきの入力可能欄**が、ワイヤ上どう来るかを実測する。
//
// 問い: `EDTCDE` / `EDTWRD` を用途 B（入出力両用）に書いた欄は
//   (a) 編集文字（`,` `.` `$` 等）を**含んだまま 1 つの入力欄**として来るのか
//   (b) EDTMSK と同じく**複数の入力欄＋保護された編集文字**へ分解されるのか
//
// (a) なら `field-validate.ts` の数値欄の許容集合 `/^[0-9.,+-]*$/` を見直す必要がある。
// (b) なら見直し不要（編集文字は欄の外＝ただの画面文字）。
//
// 画面は `TESTLIB/EDTPGM`（`build-edttest.mjs` で作成）。
//
// 実行: AS400_PASSWORD=... node scripts/research-edtcde.mjs
import { readFileSync } from "node:fs";
import { Session5250 } from "@ts5250/tn5250";
import { SecretCrypto } from "../packages/server/dist/secret-crypto.js";

const LIB = "TESTLIB";
const log = (s) => process.stdout.write(s + "\n");
const err = (s) => process.stderr.write(s + "\n");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rows = (s) => s.cells.map((r) => r.map((c) => c.char).join("").replace(/\s+$/, ""));

// ---------- 生レコードから SF オーダーの FFW を拾う（research-ffw.mjs と同一）----------
const ESC = 0x04, CMD_WTD = 0x11;
const O = { SOH: 0x01, RA: 0x02, EA: 0x03, TD: 0x10, SBA: 0x11, WEA: 0x12, IC: 0x13, MC: 0x14, WDSF: 0x15, X1C: 0x1c, SF: 0x1d };
function ffwsOf(rec) {
  const out = [];
  let i = 0;
  while (i < rec.length) {
    if (rec[i] !== ESC) { i++; continue; }
    const cmd = rec[i + 1];
    i += 2;
    if (cmd !== CMD_WTD) continue;
    i += 2;
    while (i < rec.length && rec[i] !== ESC) {
      const b = rec[i];
      switch (b) {
        case O.SBA: case O.IC: case O.MC: i += 3; break;
        case O.RA: i += 4; break;
        case O.EA: { const len = rec[i + 3]; i += 4 + Math.max(0, len - 1); break; }
        case O.SOH: i += 2 + rec[i + 1]; break;
        case O.TD: { const len = (rec[i + 1] << 8) | rec[i + 2]; i += 3 + len; break; }
        case O.WEA: i += 2; break;
        case O.X1C: i += 1; break;
        case O.WDSF: { const len = (rec[i + 1] << 8) | rec[i + 2]; i += 1 + len; break; }
        case O.SF: {
          let p = i + 1;
          const first = rec[p];
          if (first >= 0x20 && first <= 0x3f) { p += 3; break; }
          const ffw = (rec[p] << 8) | rec[p + 1];
          p += 2;
          while (p + 1 < rec.length && (rec[p] & 0xc0) === 0x80) p += 2;
          p += 1;
          const length = (rec[p] << 8) | rec[p + 1]; p += 2;
          out.push({ ffw, length });
          i = p;
          break;
        }
        default: i += 1; break;
      }
      if (b === O.SF) continue;
    }
  }
  return out;
}
const SHIFT = { 0: "alpha", 1: "alpha-only", 2: "num-shift", 3: "num-only", 4: "katakana", 5: "digits-only", 6: "io", 7: "signed-num" };
function describe(ffw) {
  const bits = [];
  if (ffw & 0x2000) bits.push("BYPASS");
  if (ffw & 0x1000) bits.push("**DUP_ENABLE**");
  if (ffw & 0x0080) bits.push("AUTO_ENTER");
  if (ffw & 0x0040) bits.push("FER");
  if (ffw & 0x0020) bits.push("MONOCASE");
  if (ffw & 0x0008) bits.push("MANDATORY_ENTER");
  return `shift=${(SHIFT[(ffw & 0x0700) >> 8] ?? "?").padEnd(11)} ${bits.join(" ")}`.trimEnd();
}

const captured = [];
async function connectOnce(sys, password, dev) {
  const s = await Session5250.connect({
    host: sys.host, port: sys.port ?? 23, ccsid: sys.ccsid ?? 37, screenSize: "27x132",
    deviceName: dev, user: sys.signon.user, password, traceRecords: true,
    warn: (w) => {
      const m = /^rx record \(\d+ bytes\): (.+)$/.exec(w);
      if (m) captured.push(Uint8Array.from(m[1].split(" ").map((h) => parseInt(h, 16))));
      else err("WARN: " + w);
    }
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
    catch (e) { last = e; err(`connect retry ${i + 1} (${dev}): ${e.message}`); await sleep(7000); }
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

const conns = JSON.parse(readFileSync("connections.json", "utf8"));
const sys = conns.systems.find((s) => s.name === "実機");
const password = process.env.AS400_PASSWORD ?? SecretCrypto.fromEnv().decrypt(sys.signon.passwordEnc);
const session = await connectHost(sys, password);
try {
  await cmd(session, `ADDLIBLE ${LIB}`);
  captured.length = 0;
  const snap = await cmd(session, `CALL ${LIB}/EDTPGM`, 30000);

  log("==== 画面（行ごと。`|` で端を示す）====");
  rows(snap).forEach((l, i) => l.trim() && log(`  r${String(i + 1).padStart(2)}|${l}|`));

  log("\n==== 入力欄（core の解釈）====");
  const inputs = snap.fields.filter((f) => !f.protected);
  inputs.forEach((f, i) =>
    log(`  in#${i + 1} r${f.row} c${f.col} len=${f.length} numeric=${f.numeric} signed=${f.signedNumeric ?? false} value=${JSON.stringify(f.value)}`));

  log("\n==== FFW 実測（生データストリームから独立にパース）====");
  let best = [];
  for (const rec of captured) { const f = ffwsOf(rec); if (f.length > best.length) best = f; }
  best.filter((f) => (f.ffw & 0x2000) === 0).forEach((f, i) =>
    log(`  in#${i + 1} len=${String(f.length).padStart(2)} FFW=0x${f.ffw.toString(16).padStart(4, "0")}  ${describe(f.ffw)}`));

  log("\n==== 判定 ====");
  log(`入力欄の数: ${inputs.length}`);
  log("DDS は EDTCDE(1) B / EDTWRD B / EDTCDE(J) B / plain 6 2 B の **4 欄**を宣言している。");
  log(inputs.length === 4
    ? "→ **分解されていない**（編集文字ごと 1 欄で来る可能性）。欄の中身と桁を上の画面で確かめること"
    : `→ **分解されている**（宣言 4 欄に対し ${inputs.length} 欄）。編集文字は欄の外＝ただの画面文字`);

  await session.sendAid("F3", { timeoutMs: 15000 });
  await sleep(500);
} catch (e) {
  err("ERROR: " + e.message + "\n" + (e.stack ?? ""));
  process.exitCode = 1;
} finally {
  await session.disconnect();
}
process.exit(process.exitCode ?? 0);
