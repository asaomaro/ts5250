// 実機で **EDTMSK つき入力欄がワイヤ上どう来るか**を実測する。
//
// 問い: backlog（`input-assist.md`）は「EDTMSK が付いた欄は**分解されて届く**」を前提に
// datepicker の判定材料（署名 `2/2/2` / `2:2:2`）を組んでいる。**その数値は合成データ
// ストリームで測ったもので実機では未確認**。直近（PR #212）で `EDTCDE`/`EDTWRD` は
// 「用途 B でも書けるが**分解されない**」と実測されているので、EDTMSK も分解しない可能性がある。
//
// **検証対象の実装（core の screen 層）に依存させない。** `traceRecords` の生バイトを
// 独立にパースして SF オーダーを並べる（`research-adjust.mjs` と同じ作法）。
//
// 前提: `build-dttest.mjs` 済み（TESTLIB/DTMPGM）。
// 実行: AS400_PASSWORD=... node scripts/research-edtmsk.mjs
import { readFileSync } from "node:fs";
import { Session5250 } from "@as400web/tn5250";

const LIB = "TESTLIB";
const log = (s) => process.stdout.write(s + "\n");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rows = (s) => s.cells.map((r) => r.map((c) => c.char).join("").replace(/\s+$/, ""));

// ---- 独立パーサ（core を通さない）----
const ESC = 0x04, SF = 0x1d, SBA = 0x11, IC = 0x13, RA = 0x02, SOH = 0x01, WEA = 0x12;

/**
 * WTD のデータを走査して SF（Start of Field）と SBA を並べる。
 * SF の並びは `[FFW(2)][FCW(2)*] attr(1) length(2)`。FCW は上位ビットで見分ける。
 */
function scanOrders(bytes) {
  const out = [];
  let row = 0, col = 0;
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i];
    if (b === ESC) {
      i += 2; // ESC + コマンド + （WTD なら CC1/CC2 が続く）
      continue;
    }
    if (b === SBA) {
      row = bytes[i + 1];
      col = bytes[i + 2];
      i += 2;
      continue;
    }
    if (b === SF) {
      let p = i + 1;
      const ffw = (bytes[p] << 8) | bytes[p + 1];
      p += 2;
      const fcws = [];
      // FFW の後に FCW が並ぶ（先頭バイトの上位 2 ビットが 0b01 でないものが属性バイト）
      while (p + 1 < bytes.length && (bytes[p] & 0x80) === 0x80) {
        fcws.push(((bytes[p] << 8) | bytes[p + 1]).toString(16).padStart(4, "0"));
        p += 2;
      }
      const attr = bytes[p];
      const len = (bytes[p + 1] << 8) | bytes[p + 2];
      out.push({ kind: "SF", row, col, ffw, fcws, attr, len });
      col += len;
      i = p + 2;
      continue;
    }
    if (b === IC) { i += 2; continue; }
    if (b === RA) { i += 3; continue; }
    if (b === SOH) { i += bytes[i + 1]; continue; }
    if (b === WEA) { i += 2; continue; }
  }
  return out;
}

const shiftName = (ffw) =>
  ["alpha", "alpha-only", "num-shift", "num-only", "katakana", "digits-only", "io", "signed-num"][
    (ffw & 0x0700) >> 8
  ];
const isInput = (ffw) => (ffw & 0xc000) === 0x4000;
const isProtected = (ffw) => (ffw & 0x2000) !== 0;

async function run(session, cmd, timeoutMs = 30000) {
  const s = session.snapshot();
  const cf = s.fields.filter((f) => !f.protected).slice(-1)[0];
  session.setField({ index: cf.index }, cmd);
  await session.sendAid("Enter", { cursor: { row: cf.row, col: cf.col }, timeoutMs });
  await sleep(600);
  return session.snapshot();
}
async function connectOnce(sys, password, dev) {
  const s = await Session5250.connect({
    host: sys.host, port: sys.port ?? 23, ccsid: sys.ccsid ?? 37, screenSize: "27x132",
    deviceName: dev, user: sys.signon.user, password, traceRecords: true,
    // **hex は warn 経由でしか取れない**（`session.ts:400`）。`research-adjust.mjs` と同じ作法
    warn: (w) => {
      const m = /^rx record \(\d+ bytes\): (.+)$/.exec(w);
      if (m) captured.push(Uint8Array.from(m[1].split(" ").map((h) => parseInt(h, 16))));
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
    } else await s.sendAid("Enter", { timeoutMs: 10000 });
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
    catch (e) { last = e; process.stderr.write(`connect retry ${i + 1} (${dev}): ${e.message}\n`); await sleep(6000); }
  }
  throw last;
}

const captured = [];
const conns = JSON.parse(readFileSync("connections.json", "utf8"));
const sys = conns.systems.find((s) => s.name === "実機");
const password = process.env.AS400_PASSWORD;
if (!password) { log("AS400_PASSWORD が未設定です"); process.exit(1); }
const session = await connectHost(sys, password);
try {
  await run(session, `ADDLIBLE ${LIB}`);
  captured.length = 0; // ここから先の受信だけを見る
  const snap = await run(session, `CALL ${LIB}/DTMPGM`, 40000);
  await sleep(800);

  log("---- 画面（DTMPGM）----");
  for (const r of rows(session.snapshot()).slice(0, 22)) if (r.trim()) log("  " + r);

  log(`\n---- 受信レコード ${captured.length} 件を独立パース ----`);
  const all = [];
  for (const bytes of captured) all.push(...scanOrders(bytes));
  log(`SF オーダー ${all.length} 件（入力欄だけ表示。行 3〜20）`);
  for (const o of all) {
    if (o.row < 2 || o.row > 22) continue;
    const kind = isInput(o.ffw) ? (isProtected(o.ffw) ? "protected" : "INPUT") : "attr-only";
    log(
      `  行${String(o.row).padStart(2)} 桁${String(o.col).padStart(3)} 長${String(o.len).padStart(2)} ` +
        `ffw=${o.ffw.toString(16).padStart(4, "0")} shift=${shiftName(o.ffw).padEnd(10)} ${kind}` +
        (o.fcws.length ? ` fcw=${o.fcws.join(",")}` : "")
    );
  }

  // core の解釈（比較用）。**独立パースと食い違えば、そこが調べどころ**
  log("\n---- core の解釈（snapshot.fields。非保護のみ）----");
  for (const f of snap.fields.filter((x) => !x.protected)) {
    log(`  行${String(f.row).padStart(2)} 桁${String(f.col).padStart(3)} 長${String(f.length).padStart(2)} numeric=${f.numeric} value=${JSON.stringify(f.value)}`);
  }

  log("\n---- 行ごとの並び（分解されているかを目で見る）----");
  const byRow = new Map();
  for (const f of snap.fields) {
    if (f.row < 2 || f.row > 22) continue;
    const list = byRow.get(f.row) ?? [];
    list.push(f);
    byRow.set(f.row, list);
  }
  const text = rows(snap);
  for (const [row, list] of [...byRow.entries()].sort((a, b) => a[0] - b[0])) {
    const line = text[row - 1] ?? "";
    const desc = list
      .sort((a, b) => a.col - b.col)
      .map((f) => `${f.col}:${f.length}${f.protected ? "P" : "I"}`)
      .join(" ");
    log(`  行${String(row).padStart(2)} [${desc}]  「${line.trim().slice(0, 60)}」`);
  }
  await session.sendAid("F3", { timeoutMs: 15000 });
} catch (e) {
  log("ERROR: " + (e instanceof Error ? e.message : String(e)));
  log(e?.stack ?? "");
} finally {
  await session.disconnect();
}
