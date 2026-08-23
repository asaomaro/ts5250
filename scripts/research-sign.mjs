// 実機で **符号付き数値の送信表現**を実測する（research 用）。
//
// 問い: 負の値をホストへ正しく届けるには、端末は何を送ればよいか。
//
//   (A) `-12`      … いまの実装が送る形（先頭に符号）
//   (B) `    12-`  … 原典の Field− が作る形（**右寄せして最終桁＝符号桁に `-`**。
//                     GNU tn5250 `display.c` の `kf_field_minus`）
//   (C) `12`       … 正の対照
//   (D) `    12`   … 右寄せした正の対照
//
// これを `TESTLIB/SGNPGM`（`build-sgntest.mjs` で作成）の
// 符号付き数値欄（`6S 0`）・ゾーン数値欄（`6 0`）へ送り、RPG が返す `[...]` を読む。
// **どちらの形なら負値として解釈されるか**が分かれば、端末側の実装が決まる。
//
// あわせて FFW も採り、`DUP` キーワードが `DUP_ENABLE`（0x1000）を立てるかを確かめる。
//
// 実行: AS400_PASSWORD=... node scripts/research-sign.mjs
import { readFileSync } from "node:fs";
import { Session5250 } from "@ts5250/tn5250";
import { SecretCrypto } from "../packages/server/dist/secret-crypto.js";

const LIB = process.env.AS400_LIB ?? "TESTLIB";
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
const sys = conns.systems.find((s) => s.name === (process.env.AS400_SYSTEM ?? "AS400"));
const password = process.env.AS400_PASSWORD ?? SecretCrypto.fromEnv().decrypt(sys.signon.passwordEnc);
const session = await connectHost(sys, password);
try {
  await cmd(session, `ADDLIBLE ${LIB}`);
  captured.length = 0;
  let snap = await cmd(session, `CALL ${LIB}/SGNPGM`, 30000);
  err("---- 画面 ----\n" + rows(snap).filter(Boolean).slice(0, 12).join("\n"));

  // ---- FFW（DUP キーワードがビットを立てるか）----
  let best = [];
  for (const rec of captured) { const f = ffwsOf(rec); if (f.length > best.length) best = f; }
  log("==== FFW 実測（入力欄のみ・SGN / NUM / NMO / DUPF の順）====");
  best.filter((f) => (f.ffw & 0x2000) === 0).forEach((f, i) => {
    const labels = ["SGN 6S0", "NUM 6 0", "NMO 6M", "DUPF DUP"];
    log(`in#${i + 1} ${(labels[i] ?? "?").padEnd(9)} len=${String(f.length).padStart(2)} FFW=0x${f.ffw.toString(16).padStart(4, "0")}  ${describe(f.ffw)}`);
  });

  // ---- 送信表現の総当たり ----
  // 入力欄は DDS 順: 0=SGN(6S0) 1=NUM(6 0) 2=NMO(6M) 3=DUPF
  //
  // **欄ごとに 1 つずつ送る。** 最初は SGN と NUM へ同時に入れたところ CPF5257（入出力エラー）が
  // 出たが、どちらの欄が原因かが分からなかった。混ぜて測ると切り分けられない。
  const FIELDS = [
    { idx: 0, name: "SGN 6S 0 (signed)", needle: "S 6S0" },
    { idx: 1, name: "NUM 6 0  (zoned) ", needle: "N 6 0" },
    { idx: 2, name: "NMO 6M   (numonly)", needle: "M 6M" }
  ];
  const FORMS = [
    { label: "'-12'      先頭に符号（いまの実装）", v: "-12" },
    { label: "'    12-'  最終桁が符号（原典の Field−）", v: "    12-" },
    { label: "'12-'      左詰め＋符号", v: "12-" },
    { label: "'    12'   正の対照（右寄せ）", v: "    12" }
  ];

  /** 画面が SGNR でなければ復帰させる（エラー画面には応答してから掛け直す） */
  async function ensureScreen() {
    for (let i = 0; i < 4; i++) {
      const inputs = session.snapshot().fields.filter((f) => !f.protected);
      if (inputs.length >= 4) return inputs;
      const txt = rows(session.snapshot()).filter(Boolean);
      if (i === 0) { log("    （エラー画面）" + txt.slice(1, 4).map((l) => l.trim()).join(" / ").slice(0, 160)); }
      await session.sendAid("Enter", { timeoutMs: 15000 });
      await sleep(1200);
      const again = session.snapshot().fields.filter((f) => !f.protected);
      if (again.length >= 4) return again;
      await cmd(session, `CALL ${LIB}/SGNPGM`, 30000);
    }
    return session.snapshot().fields.filter((f) => !f.protected);
  }

  log("\n==== 送信表現 → ホストが受け取った値（欄ごとに 1 つずつ）====");
  for (const f of FIELDS) {
    log(`\n-- ${f.name} --`);
    for (const form of FORMS) {
      const inputs = await ensureScreen();
      if (inputs.length < 4) { log("  復帰できないので中断"); break; }
      let note = "";
      try { session.setField({ index: inputs[f.idx].index }, form.v); }
      catch (e) { log(`  ${form.label.padEnd(40)} 送信前検証で拒否: ${e.code ?? e.message}`); continue; }
      await session.sendAid("Enter", { cursor: { row: inputs[0].row, col: inputs[0].col }, timeoutMs: 20000 });
      await sleep(1300);
      const txt = rows(session.snapshot()).filter(Boolean);
      const line = txt.find((l) => l.includes(f.needle));
      if (!line) {
        const head = txt.slice(1, 4).map((l) => l.trim()).filter(Boolean).join(" / ");
        note = `**ホストがエラー** ${head.slice(0, 120)}`;
      }
      log(`  ${form.label.padEnd(40)} ${line ? line.replace(/\s+/g, " ").trim() : note}`);
    }
  }

  // ---- Dup 文字（0x1C）が届くか ----
  // 端末側の Dup はまだ無いので、**生バイトのセンチネル**で 0x1C を 6 桁ぶん載せて送る
  log("\n==== Dup 文字（0x1C×6）を DUP 欄へ ====");
  const dupChar = String.fromCharCode(0xe000 + 0x1c); // rawSentinel(0x1C) 相当
  const inputs = session.snapshot().fields.filter((f) => !f.protected);
  try {
    if (inputs.length < 4) throw new Error(`入力欄が ${inputs.length} 件しかない`);
    session.setField({ index: inputs[3].index }, dupChar.repeat(6));
    await session.sendAid("Enter", { cursor: { row: inputs[0].row, col: inputs[0].col }, timeoutMs: 20000 });
    await sleep(1200);
    const txt = rows(session.snapshot()).filter(Boolean);
    log("DUPF: " + (txt.find((l) => l.includes("A DUP"))?.replace(/\s+/g, " ").trim() ?? "?"));
    log("→ `[ALLDUP]` なら 0x1C がそのまま届いている");
  } catch (e) {
    log("センチネルでの送信は拒否された: " + (e.code ?? e.message));
  }

  await session.sendAid("F3", { timeoutMs: 15000 });
  await sleep(500);
} catch (e) {
  err("ERROR: " + e.message + "\n" + (e.stack ?? ""));
  process.exitCode = 1;
} finally {
  await session.disconnect();
}
process.exit(process.exitCode ?? 0);
