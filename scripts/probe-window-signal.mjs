// 調査: 「窓が出ている」ことを罫線文字以外から判定できるか。
// F1 ヘルプ前後のデータストリームを実機から採り、CLEAR の有無と書き込み範囲（SBA）を見る。
// 実行: node --env-file=.env --env-file=.env.verify scripts/probe-window-signal.mjs
import { readFileSync } from "node:fs";
import { Session5250 } from "@ts5250/tn5250";
import { SecretCrypto } from "../packages/server/dist/secret-crypto.js";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (s) => process.stderr.write(s + "\n");

const cfg = JSON.parse(readFileSync("connections.json", "utf8"));
const sys = cfg.systems.find((s) => s.name === (process.env.AS400_SYSTEM ?? "AS400")) ?? cfg.systems[0];
const sess = (cfg.sessions ?? []).find((s) => s.system === sys.name && s.kind !== "printer") ?? {};
const crypto = SecretCrypto.fromEnv();
const password = sys.password ? crypto.decrypt(sys.password) : undefined;

const ESC = 0x04;
const ORDER = { SBA: 0x11, SF: 0x1d, IC: 0x13, RA: 0x02, EA: 0x03, SOH: 0x01 };
const CMD = { CLEAR_UNIT: 0x40, CLEAR_UNIT_ALT: 0x20, WTD: 0x11, WSF: 0xf3 };

/** レコードの中身を「命令の並び」に要約する（SBA の宛先と書いた桁数を数える） */
function summarize(hex) {
  const b = hex.split(" ").map((x) => parseInt(x, 16));
  const out = [];
  let wrote = 0;
  const rowsTouched = new Set();
  let cur = null;
  for (let i = 0; i < b.length; i++) {
    if (b[i] === ESC) {
      const cmd = b[i + 1];
      if (cmd === CMD.CLEAR_UNIT) out.push("CLEAR_UNIT");
      else if (cmd === CMD.CLEAR_UNIT_ALT) out.push("CLEAR_UNIT_ALT");
      else if (cmd === CMD.WTD) out.push("WTD");
      else if (cmd === CMD.WSF) out.push("WSF");
      i++;
      continue;
    }
    if (b[i] === ORDER.SBA) {
      const r = b[i + 1];
      const c = b[i + 2];
      cur = { r, c };
      rowsTouched.add(r);
      i += 2;
      continue;
    }
    if (b[i] === ORDER.SF) { i += 3; continue; }
    if (b[i] === ORDER.IC) { i += 2; continue; }
    if (b[i] === ORDER.RA) { i += 4; continue; }
    if (b[i] >= 0x40) { wrote++; if (cur) rowsTouched.add(cur.r); }
  }
  return { orders: [...new Set(out)], wrote, rows: [...rowsTouched].sort((a, z) => a - z) };
}

const records = [];
const session = await Session5250.connect({
  host: sys.host,
  port: sys.port ?? 23,
  deviceName: sess.deviceName ?? "DEV1",
  ccsid: sess.ccsid ?? 939,
  tls: sys.tls ? { rejectUnauthorized: false } : undefined,
  traceRecords: true,
  // traceRecords は warn へ「rx record (N bytes): hex」を流す（session.ts:348）。ここで拾う。
  warn: (w) => {
    const m = /^rx record \((\d+) bytes\): (.+)$/.exec(String(w));
    if (m) records.push({ len: Number(m[1]), hex: m[2] });
  },
});

const screen = () =>
  (session.snapshot()?.cells ?? []).map((row) => row.map((c) => (c.char === "" ? " " : c.char)).join("").replace(/\s+$/, ""));

/** 入力欄へ値を入れる（API 名の違いを吸収） */
function setField(idx, v) {
  session.setField({ index: idx }, v);
}

async function send(fn) {
  const n = records.length;
  await fn();
  for (let i = 0; i < 40 && records.length === n; i++) await sleep(200);
  await sleep(700);
  return records.slice(n);
}

try {
  await sleep(1500);
  // サインオン → メニュー
  for (let i = 0; i < 8; i++) {
    const s = screen().join("\n");
    if (s.includes("メインメニュー")) break;
    if (s.includes("サイン")) {
      const f = session.snapshot().fields.filter((x) => !x.protected);
      setField(f[0].index, "USER"); setField(f[1].index, password ?? "");
      await send(() => session.sendAid("Enter"));
    } else if (s.includes("回復") || s.includes("中断")) {
      const f = session.snapshot().fields.filter((x) => !x.protected);
      setField(f[0].index, "90");
      await send(() => session.sendAid("Enter"));
    } else await send(() => session.sendAid("Enter"));
  }
  log("メニュー到達: " + screen().join("\n").includes("メインメニュー"));

  log("\n===== F1（ヘルプを開く）で来たレコード =====");
  const helpRecs = await send(() => session.sendAid("F1"));
  helpRecs.forEach((r, i) => {
    const s = summarize(r.hex);
    log(`  rec${i} len=${r.len} orders=[${s.orders}] 書いた桁数=${s.wrote} 触れた行=${s.rows.join(",")}`);
  });
  log("\n  ヘルプ表示中の画面（上から）:");
  screen().slice(0, 8).forEach((l, i) => l && log(`    r${i + 1}|${l}|`));
} catch (e) {
  log("ERR " + (e?.stack ?? e));
} finally {
  session.disconnect?.();
  process.exit(0);
}
