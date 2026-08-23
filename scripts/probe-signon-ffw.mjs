// サインオン画面の FFW を採る（ログインせずに最初の画面だけ見る）。
//
// 【結論・2026-07-29 実測】**サインオン画面の入力欄に必須指定（MANDATORY_ENTER / MANDATORY_FILL）は
// 載っていない**。ユーザー欄とパスワード欄が `0x4020`（MONOCASE のみ）、残る 3 欄が `0x4000`。
// → Enter に必須検証を掛けても**サインオンを塞がない**ことが確かめられた。
//
// 経緯: 必須検証を入れた直後にブラウザ検証がサインオンで止まり、この検証が原因かを疑った。
// 実バイトを採って**濡れ衣だと分かり**（実際の原因は検証スクリプトの打鍵位置）、
// 見当違いの手直しをせずに済んだ。同じ疑いが再燃したときのために残す。
//
// 実行: AS400_PASSWORD=... node scripts/probe-signon-ffw.mjs
import { readFileSync } from "node:fs";
import { Session5250 } from "@ts5250/tn5250";

const log = (s) => process.stdout.write(s + "\n");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
const ADJ = { 0: "none", 5: "right-zero", 6: "right-blank", 7: "mandatory-fill" };
function describe(ffw) {
  const bits = [];
  if (ffw & 0x2000) bits.push("BYPASS");
  if (ffw & 0x0800) bits.push("MDT");
  if (ffw & 0x0080) bits.push("AUTO_ENTER");
  if (ffw & 0x0040) bits.push("FER");
  if (ffw & 0x0020) bits.push("MONOCASE");
  if (ffw & 0x0008) bits.push("**MANDATORY_ENTER**");
  const adj = ffw & 0x0007;
  return `shift=${(SHIFT[(ffw & 0x0700) >> 8] ?? "?").padEnd(11)} adjust=${(ADJ[adj] ?? adj).toString().padEnd(14)} ${bits.join(" ")}`.trimEnd();
}

const captured = [];
const conns = JSON.parse(readFileSync("connections.json", "utf8"));
const sys = conns.systems.find((s) => s.name === (process.env.AS400_SYSTEM ?? "AS400"));
// 装置名は使い回す（ユニーク名は QAUTOVRT 上限に当たる）。直前の実行が残っていることがあるので
// プールを順に試す（scripts/README.md の作法）
async function connect() {
  const pool = ["WEBSF0", "WEBSF1", "WEBSF2", "WEBSF3", "WEBSF4"];
  let last;
  for (let i = 0; i < 12; i++) {
    const dev = pool[i % pool.length];
    try {
      return await Session5250.connect({
        host: sys.host, port: sys.port ?? 23, ccsid: sys.ccsid ?? 37, screenSize: "27x132",
        deviceName: dev, user: sys.signon.user, password: process.env.AS400_PASSWORD,
        warn: (w) => {
          const m = /^rx record \(\d+ bytes\): (.+)$/.exec(w);
          if (m) captured.push(Uint8Array.from(m[1].split(" ").map((h) => parseInt(h, 16))));
        },
        traceRecords: true
      });
    } catch (e) { last = e; process.stderr.write(`retry ${i + 1} (${dev}): ${e.message}\n`); await sleep(6000); }
  }
  throw last;
}
const s = await connect();
await sleep(2500);
const snap = s.snapshot();
log("---- 画面 ----");
snap.cells.map((r) => r.map((c) => c.char).join("").replace(/\s+$/, "")).filter(Boolean).slice(0, 12).forEach((l) => log("  " + l));
let best = [];
for (const rec of captured) { const f = ffwsOf(rec); if (f.length > best.length) best = f; }
log(`\n---- FFW（SF ${best.length} 件・画面順）----`);
best.forEach((f, i) => log(`#${String(i + 1).padStart(2)} len=${String(f.length).padStart(3)} FFW=0x${f.ffw.toString(16).padStart(4, "0")}  ${describe(f.ffw)}`));
log(`\n---- 入力欄のみ ----`);
best.filter((f) => (f.ffw & 0x2000) === 0).forEach((f, i) =>
  log(`in#${String(i + 1).padStart(2)} len=${String(f.length).padStart(3)} FFW=0x${f.ffw.toString(16).padStart(4, "0")}  ${describe(f.ffw)}`));
log("\n---- snapshot の Field（core の解釈）----");
snap.fields.filter((f) => !f.protected).forEach((f) =>
  log(`  r${f.row} c${f.col} len${f.length} mandatoryEnter=${f.mandatoryEnter} adjust=${f.adjust} monocase=${f.monocase} hidden=${f.hidden}`));
s.disconnect();
process.exit(0);
