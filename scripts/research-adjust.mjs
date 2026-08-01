// 実機の TESTLIB/ADJPGM を呼び、**ホストが実際に送ってくる FFW** を生データストリームから
// 取り出して並べる（research 用）。`build-adjtest.mjs` で作った画面が前提。
//
// 目的: FFW の ADJUST（右寄せ）ビットを実装する前に、
//   (1) DDS の CHECK(RZ)/CHECK(RB)/CHECK(MF)/CHECK(FE)/CHECK(ME) が本当に FFW へ載るのか
//   (2) 素の数値欄・符号付き数値欄（S）に ADJUST が既定で付くのか
// を実測する。**推測で実装しない**（AGENTS.md「既存プロトコル実装の移植」）。
//
// FFW の解釈は core を通さず**この場で独立に**パースする。core 側の解釈が正しいかまで
// 同時に確かめたいので、検証対象の実装に依存させない。
//
// 実行: node --env-file=.env scripts/research-adjust.mjs
import { readFileSync } from "node:fs";
import { Session5250 } from "@as400web/tn5250";
import { SecretCrypto } from "../packages/server/dist/secret-crypto.js";

const LIB = "TESTLIB";
const log = (s) => process.stdout.write(s + "\n");
const err = (s) => process.stderr.write(s + "\n");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rows = (s) => s.cells.map((r) => r.map((c) => c.char).join("").replace(/\s+$/, ""));

// ---------- 生レコードから SF オーダーの FFW を拾う ----------
const ESC = 0x04, CMD_WTD = 0x11;
const O = { SOH: 0x01, RA: 0x02, EA: 0x03, TD: 0x10, SBA: 0x11, WEA: 0x12, IC: 0x13, MC: 0x14, WDSF: 0x15, X1C: 0x1c, SF: 0x1d };

/**
 * WRITE TO DISPLAY の中を歩いて SF（0x1D）の FFW を順に返す。
 * オーダーの引数長は SC30-3533 / `packages/tn5250/src/protocol/wtd-applier.ts` と同じ。
 * 未知のバイトは**画面文字**なので 1 バイト読み飛ばす（オーダーではない）。
 */
function ffwsOf(rec) {
  const out = [];
  let i = 0;
  while (i < rec.length) {
    if (rec[i] !== ESC) { i++; continue; }
    const cmd = rec[i + 1];
    i += 2;
    if (cmd !== CMD_WTD) continue;      // WTD 以外（READ 等）は本体を持たないか対象外
    i += 2;                             // WTD 制御文字 CC1/CC2
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
        default: i += 1; break;         // 画面文字
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
  return `shift=${SHIFT[shift]} adjust=${ADJ[adj] ?? adj} ${bits.join(" ")}`.trim();
}

// ---------- 接続（build-adjtest.mjs と同方式） ----------
const captured = [];
async function connectOnce(sys, password, dev) {
  const s = await Session5250.connect({
    host: sys.host, port: sys.port ?? 23, ccsid: sys.ccsid ?? 37, screenSize: "27x132",
    deviceName: dev, user: sys.signon.user, password, traceRecords: true,
    warn: (w) => {
      const m = /^rx record \(\d+ bytes\): (.+)$/.exec(w);
      if (m) captured.push(Uint8Array.from(m[1].split(" ").map((h) => parseInt(h, 16))));
      else err("WARN: " + w);
    },
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

const conns = JSON.parse(readFileSync("connections.json", "utf8"));
const sys = conns.systems.find((s) => s.name === "実機");
const password = SecretCrypto.fromEnv().decrypt(sys.signon.passwordEnc);
const session = await connectHost(sys, password);
try {
  await cmd(session, `ADDLIBLE ${LIB}`);
  captured.length = 0;
  const snap = await cmd(session, `CALL ${LIB}/ADJPGM`, 30000);
  const screen = rows(snap).filter(Boolean);
  err("---- 画面 ----\n" + screen.slice(0, 22).join("\n"));

  // 画面を出したレコード = SF を最も多く含むもの
  let best = [];
  for (const rec of captured) {
    const f = ffwsOf(rec);
    if (f.length > best.length) best = f;
  }
  log(`\n==== FFW 実測（SF ${best.length} 件・画面順） ====`);
  best.forEach((f, i) => {
    log(`#${String(i + 1).padStart(2)} len=${String(f.length).padStart(3)} FFW=0x${f.ffw.toString(16).padStart(4, "0")}  ${describe(f.ffw)}`);
  });

  // 入力欄（BYPASS でない）だけを DDS の並びと突き合わせられる形で再掲
  log(`\n==== 入力欄のみ（DDS の CASES 順に対応） ====`);
  best.filter((f) => (f.ffw & 0x2000) === 0).forEach((f, i) => {
    log(`in#${String(i + 1).padStart(2)} len=${String(f.length).padStart(3)} FFW=0x${f.ffw.toString(16).padStart(4, "0")}  ${describe(f.ffw)}`);
  });

  await session.sendAid("F3", { timeoutMs: 15000 });
  await sleep(500);
} catch (e) {
  err("ERROR: " + e.message + "\n" + (e.stack ?? ""));
  process.exitCode = 1;
} finally {
  await session.disconnect();
}
