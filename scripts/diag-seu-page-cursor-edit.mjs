// ケースD/E専用（編集モード, OPTION(2)）。前回スクリプトは同一SEUセッション内で
// STRSEUを打ち直しており、SEU==>のサブコマンドとして無視されていた（システムのコマンド行に
// 戻れていなかった）。この版は毎回、まず F12（取り消し）でSEUを抜けてから開き直す。
//
// 実行: node --env-file=.env --env-file=.env.verify scripts/diag-seu-page-cursor-edit.mjs
import { Session5250 } from "@ts5250/tn5250";

const host = process.env.AS400_HOST, user = process.env.AS400_USER, password = process.env.AS400_PASSWORD;
const LIB = process.env.AS400_LIB ?? "TESTLIB";
if (!host || !user || !password) { process.stderr.write("AS400_* が要ります\n"); process.exit(2); }
const log = (s) => process.stdout.write(s + "\n");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const text = (s) => s.cells.map((r) => r.map((c) => c.char).join("").replace(/ +$/u, "")).join("\n");

const ORDER = { SBA: 0x11, SF: 0x1d, IC: 0x13, MC: 0x14, RA: 0x02, EA: 0x03 };
const rx = [];
const session = await Session5250.connect({
  host, port: 23, ccsid: 5035, screenSize: "24x80",
  traceRecords: true,
  warn: (w) => {
    const m = /^rx record \((\d+) bytes\): (.+)$/.exec(String(w));
    if (m) rx.push({ len: Number(m[1]), hex: m[2] });
  },
});
function hasOrder(hex, orderByte) { return hex.split(" ").map((x) => parseInt(x, 16)).includes(orderByte); }
function snap() { return session.snapshot(); }
async function drain(fn, label) {
  const n = rx.length;
  await fn();
  for (let i = 0; i < 60 && rx.length === n; i++) await sleep(200);
  await sleep(500);
  const recs = rx.slice(n);
  const ic = recs.some((r) => hasOrder(r.hex, ORDER.IC));
  const mc = recs.some((r) => hasOrder(r.hex, ORDER.MC));
  log(`  [${label}] 受信 ${recs.length} レコード  IC含む=${ic}  MC含む=${mc}`);
  return { recs, ic, mc };
}
function dump(label, rows = 22) {
  const s = snap();
  log(`\n===== ${label} (cursor ${s.cursor.row}/${s.cursor.col}) =====`);
  text(s).split("\n").slice(0, rows).forEach((l, i) => { if (l.trim()) log(String(i + 1).padStart(2) + "|" + l); });
  const inputs = s.fields.filter((f) => !f.protected);
  log(`  入力欄: ` + inputs.map((f) => `#${f.index} r${f.row}c${f.col}(${f.length})`).join(" "));
  return s;
}

// --- サインオン ---
let s = snap();
for (let i = 0; i < 10; i++) {
  const t = text(s);
  if (t.includes("コマンドを入力") || t.includes("Selection or command")) break;
  const inputs = s.fields.filter((f) => !f.protected);
  if (t.includes("サイン・オン") || t.includes("Sign On")) {
    if (inputs[0]) session.setField({ index: inputs[0].index }, user);
    if (inputs[1]) session.setField({ index: inputs[1].index }, password);
  } else if (t.includes("回復")) { if (inputs[0]) session.setField({ index: inputs[0].index }, "90"); }
  await session.sendAid("Enter", { timeoutMs: 15000 });
  await sleep(700);
  s = snap();
}
dump("コマンド行");
const cmdField = () => snap().fields.filter((f) => !f.protected).find((f) => f.length > 20);

async function openEdit() {
  const c = cmdField();
  session.setField({ index: c.index }, `STRSEU SRCFILE(${LIB}/QCLSRC) SRCMBR(PAGECURS) OPTION(2)`);
  rx.length = 0;
  await session.sendAid("Enter", { timeoutMs: 25000 });
  await sleep(1500);
  let d = dump("STRSEU OPTION(2) 直後");
  if (text(d).includes("回復")) {
    const sel = d.fields.filter((f) => !f.protected).pop();
    if (sel) session.setField({ index: sel.index }, "2");
    await session.sendAid("Enter", { timeoutMs: 20000 });
    await sleep(1200);
    d = dump("回復画面を2で抜けた後");
  }
  return d;
}

/** SEUを抜けてシステムのコマンド行へ戻る（F12→確認があればF12/Enter） */
async function exitSeu() {
  await session.sendAid("F12", { timeoutMs: 15000 }).catch(() => {});
  await sleep(800);
  let d = dump("F12直後");
  if (!cmdField()) {
    // 変更確認 or 何か聞かれている場合、Enterで抜ける
    await session.sendAid("Enter", { timeoutMs: 15000 }).catch(() => {});
    await sleep(800);
    d = dump("F12→Enter直後");
  }
  return d;
}

function bodyFieldAt(d, row) {
  return d.fields.find((f) => !f.protected && f.row === row && f.col > 6);
}
async function pageWithCursor(dir, cursor, label) {
  const beforeText = text(snap());
  await drain(() => session.sendAid(dir, { timeoutMs: 15000, cursor }), label);
  const d = dump(`${label} 後`);
  const changed = text(d) !== beforeText;
  log(`  送信カーソル ${cursor.row}/${cursor.col}  画面変化=${changed}  受信後カーソル ${d.cursor.row}/${d.cursor.col}`);
  return { changed, after: d.cursor, screen: d };
}

// === ケースD: 編集モード、本文行カーソルから PageDown（非境界→境界） ===
log("\n########## ケースD: 編集モード、本文行カーソルから PageDown（非境界→境界） ##########");
{
  const d0 = await openEdit();
  const bf = bodyFieldAt(d0, 8) ?? bodyFieldAt(d0, 9) ?? bodyFieldAt(d0, 7);
  log(`  本文行入力欄の例: ${bf ? `r${bf.row}c${bf.col}(${bf.length})` : "見つからず"}`);
  const cur = bf ? { row: bf.row, col: bf.col } : { row: 8, col: 9 };
  for (let i = 1; i <= 12; i++) {
    const r = await pageWithCursor("PageDown", cur, `D-PageDown #${i}`);
    if (!r.changed) { log(`  == 最終ページ到達 =={i}`); break; }
  }
  await exitSeu();
}

// === ケースE: 編集モード、本文行カーソルから PageUp（非境界→境界） ===
log("\n########## ケースE: 編集モード、本文行カーソルから PageUp（非境界→境界） ##########");
{
  const d0 = await openEdit();
  for (let i = 0; i < 6; i++) {
    await drain(() => session.sendAid("PageDown", { timeoutMs: 15000 }), `E-助走PageDown #${i}`);
  }
  const d1 = dump("末尾付近まで移動");
  const bf = bodyFieldAt(d1, 8) ?? bodyFieldAt(d1, 9) ?? bodyFieldAt(d1, 7);
  log(`  本文行入力欄の例: ${bf ? `r${bf.row}c${bf.col}(${bf.length})` : "見つからず"}`);
  const cur = bf ? { row: bf.row, col: bf.col } : { row: 8, col: 9 };
  for (let i = 1; i <= 12; i++) {
    const r = await pageWithCursor("PageUp", cur, `E-PageUp #${i}`);
    if (!r.changed) { log(`  == 先頭ページ到達 =={i}`); break; }
  }
  await exitSeu();
}

session.disconnect?.();
process.exit(0);
