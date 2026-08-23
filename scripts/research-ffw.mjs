// 実機で **FFW の挙動ビット**を実測する（research 用）。前作 `research-adjust.mjs` の
// 生データストリーム捕捉をそのまま使い、対象を ADJUST から挙動ビット全体へ広げる。
//
// 【実験 A】ホストは CHECK(ME) / CHECK(MF) を**自分で検証するのか**
//   既存の `TESTLIB/ADJPGM`（前作で作成済み）を呼び、CHECK(ME) 欄を**空**・CHECK(MF) 欄を
//   **部分入力**のまま Enter を送る。ホストが弾けばエラー画面が返り、弾かなければ RPG が
//   `[...]` で値を写して次の画面が出る。**端末側の検証が要るのかどうか**がこれで決まる。
//   （参照実装は 2 つとも AID 送信時の検証を持たない＝原典からは答えが出ない）
//
// 【実験 B】DDS のキーボード・シフトと CHECK(LC) / CHECK(ER) が FFW のどのビットになるか
//   `build-ffwtest.mjs` で作った `TESTLIB/FFWPGM` を呼び、SF オーダーの FFW を並べる。
//
// FFW の解釈は core を通さず**この場で独立に**パースする（検証対象の実装に依存させない）。
//
// 実行: node --env-file=.env --env-file=.env.verify scripts/research-ffw.mjs
import { readFileSync } from "node:fs";
import { Session5250 } from "@ts5250/tn5250";
import { SecretCrypto } from "../packages/server/dist/secret-crypto.js";

const LIB = process.env.AS400_LIB ?? "TESTLIB";
const log = (s) => process.stdout.write(s + "\n");
const err = (s) => process.stderr.write(s + "\n");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rows = (s) => s.cells.map((r) => r.map((c) => c.char).join("").replace(/\s+$/, ""));

// ---------- 生レコードから SF オーダーの FFW を拾う（research-adjust.mjs と同一）----------
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
    i += 2; // WTD 制御文字 CC1/CC2
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
          if (first >= 0x20 && first <= 0x3f) { p += 3; break; } // FFW 無し=出力専用
          const ffw = (rec[p] << 8) | rec[p + 1];
          p += 2;
          const fcws = [];
          while (p + 1 < rec.length && (rec[p] & 0xc0) === 0x80) { fcws.push((rec[p] << 8) | rec[p + 1]); p += 2; }
          const attr = rec[p]; p += 1;
          const length = (rec[p] << 8) | rec[p + 1]; p += 2;
          out.push({ ffw, fcws, attr, length });
          i = p;
          break;
        }
        default: i += 1; break; // 画面文字
      }
      if (b === O.SF) continue;
    }
  }
  return out;
}

const ADJ = { 0: "none", 5: "right-zero", 6: "right-blank", 7: "mandatory-fill" };
const SHIFT = { 0: "alpha", 1: "alpha-only", 2: "num-shift", 3: "num-only", 4: "katakana", 5: "digits-only", 6: "io", 7: "signed-num" };
function describe(ffw) {
  const bits = [];
  if (ffw & 0x2000) bits.push("BYPASS");
  if (ffw & 0x1000) bits.push("DUP");
  if (ffw & 0x0800) bits.push("MDT");
  if (ffw & 0x0080) bits.push("AUTO_ENTER");
  if (ffw & 0x0040) bits.push("FER");
  if (ffw & 0x0020) bits.push("MONOCASE");
  if (ffw & 0x0008) bits.push("MANDATORY_ENTER");
  const adj = ffw & 0x0007;
  const shift = (ffw & 0x0700) >> 8;
  return `shift=${(SHIFT[shift] ?? shift).padEnd(11)} adjust=${(ADJ[adj] ?? adj).padEnd(14)} ${bits.join(" ")}`.trimEnd();
}

// ---------- 接続 ----------
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
  for (let i = 0; i < 10; i++) {
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
/** SF を最も多く含む受信レコード＝その画面を描いたもの */
function bestFfws() {
  let best = [];
  for (const rec of captured) {
    const f = ffwsOf(rec);
    if (f.length > best.length) best = f;
  }
  return best;
}

const conns = JSON.parse(readFileSync("connections.json", "utf8"));
const sys = conns.systems.find((s) => s.name === (process.env.AS400_SYSTEM ?? "AS400"));
const password = process.env.AS400_PASSWORD ?? SecretCrypto.fromEnv().decrypt(sys.signon.passwordEnc);
const session = await connectHost(sys, password);
try {
  await cmd(session, `ADDLIBLE ${LIB}`);

  // ===================== 実験 A: ホストは ME / MF を検証するか =====================
  log("\n########## 実験 A: CHECK(ME) 空・CHECK(MF) 部分入力のまま Enter ##########");
  captured.length = 0;
  let snap = await cmd(session, `CALL ${LIB}/ADJPGM`, 30000);
  // ADJDSPF の入力欄は DDS 順: 1 ARZ / 2 ARB / 3 AMF / 4 AFE / 5 AME / 6 APLN / 7 NRZ / 8 NPLN / 9 SPLN
  const inputs = snap.fields.filter((f) => !f.protected);
  log(`入力欄 ${inputs.length} 件（期待 9）`);
  if (inputs.length >= 9) {
    session.setField({ index: inputs[2].index }, "12"); // AMF=CHECK(MF) を部分入力（6 桁中 2 桁）
    // inputs[4] = AME=CHECK(ME) は**空のまま**
    for (const i of [6, 7, 8]) session.setField({ index: inputs[i].index }, "0"); // 数値欄は 0
    await session.sendAid("Enter", { cursor: { row: inputs[0].row, col: inputs[0].col }, timeoutMs: 20000 });
    await sleep(1000);
    snap = session.snapshot();
    const txt = rows(snap).filter(Boolean);
    log("---- Enter 後の画面 ----");
    txt.slice(0, 24).forEach((l) => log("  " + l));
    log(`keyboardLocked=${snap.keyboardLocked}`);
    const echoed = txt.some((l) => /\[\s*12\s*\]/.test(l));
    log(`\n【判定】RPG が値を写した（＝ホストは弾かなかった）: ${echoed ? "はい" : "いいえ"}`);
    log(echoed
      ? "  → **ホストは CHECK(ME)/CHECK(MF) を検証しない。端末が検証しなければ誰もしない**"
      : "  → ホスト側で止まった可能性。上の画面文言を読んで切り分けること");
    await session.sendAid("F3", { timeoutMs: 15000 });
    await sleep(800);
  } else {
    log("ADJPGM の画面が期待と違う。前作の build-adjtest.mjs を先に流すこと");
    rows(snap).filter(Boolean).slice(0, 10).forEach((l) => log("  " + l));
  }

  // ===================== 実験 B: シフト種別と CHECK(LC)/CHECK(ER) の FFW =====================
  log("\n########## 実験 B: DDS シフト種別 → FFW ##########");
  captured.length = 0;
  snap = await cmd(session, `CALL ${LIB}/FFWPGM`, 30000);
  const screen = rows(snap).filter(Boolean);
  err("---- 画面 ----\n" + screen.slice(0, 24).join("\n"));
  const best = bestFfws();
  log(`\n==== FFW 実測（SF ${best.length} 件・画面順） ====`);
  best.forEach((f, i) => {
    log(`#${String(i + 1).padStart(2)} len=${String(f.length).padStart(3)} FFW=0x${f.ffw.toString(16).padStart(4, "0")}  ${describe(f.ffw)}`);
  });
  log(`\n==== 入力欄のみ（DDS の CASES 順に対応） ====`);
  // build-ffwtest.mjs の**単独コンパイルで通った順**。`Y`（num-only）は小数位が必須で
  // 文字欄としては通らず、この機の表示ファイルには載せられなかった（＝欄が 1 つ少ない）
  const labels = ["A plain", "A CHECK(LC)", "X alpha-only", "N num-shift", "W katakana", "D digits-only", "I inhibit-kbd", "M num-only-char", "A CHECK(ER)"];
  best.filter((f) => (f.ffw & 0x2000) === 0).forEach((f, i) => {
    log(`in#${String(i + 1).padStart(2)} ${(labels[i] ?? "?").padEnd(16)} len=${String(f.length).padStart(3)} FFW=0x${f.ffw.toString(16).padStart(4, "0")}  ${describe(f.ffw)}`);
  });
  await session.sendAid("F3", { timeoutMs: 15000 });
  await sleep(500);
} catch (e) {
  err("ERROR: " + e.message + "\n" + (e.stack ?? ""));
  process.exitCode = 1;
} finally {
  await session.disconnect();
}
process.exit(process.exitCode ?? 0);
