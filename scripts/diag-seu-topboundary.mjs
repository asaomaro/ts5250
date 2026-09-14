import { Session5250 } from "@ts5250/tn5250";
const host = process.env.AS400_HOST, user = process.env.AS400_USER, password = process.env.AS400_PASSWORD;
const LIB = process.env.AS400_LIB ?? "TESTLIB";
const log = (s) => process.stdout.write(s + "\n");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const text = (s) => s.cells.map((r) => r.map((c) => c.char).join("").replace(/ +$/u, "")).join("\n");
const ORDER = { IC: 0x13, MC: 0x14 };
const rx = [];
const session = await Session5250.connect({
  host, port: 23, ccsid: 5035, screenSize: "24x80", traceRecords: true,
  warn: (w) => { const m = /^rx record \((\d+) bytes\): (.+)$/.exec(String(w)); if (m) rx.push({ hex: m[2] }); },
});
function hasOrder(hex, b) { return hex.split(" ").map((x) => parseInt(x, 16)).includes(b); }
function snap() { return session.snapshot(); }
async function drain(fn, label) {
  const n = rx.length;
  await fn();
  for (let i = 0; i < 60 && rx.length === n; i++) await sleep(200);
  await sleep(500);
  const recs = rx.slice(n);
  log(`  [${label}] IC=${recs.some(r=>hasOrder(r.hex,ORDER.IC))} MC=${recs.some(r=>hasOrder(r.hex,ORDER.MC))}`);
}
function dump(label) {
  const s = snap();
  log(`\n== ${label} (cursor ${s.cursor.row}/${s.cursor.col}) ==`);
  text(s).split("\n").slice(0,14).forEach((l,i)=>{ if(l.trim()) log(String(i+1).padStart(2)+"|"+l); });
  return s;
}
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
const cmdField = () => snap().fields.filter((f) => !f.protected).find((f) => f.length > 20);
const c = cmdField();
session.setField({ index: c.index }, `STRSEU SRCFILE(${LIB}/QCLSRC) SRCMBR(PAGECURS) OPTION(2)`);
rx.length = 0;
await session.sendAid("Enter", { timeoutMs: 25000 });
await sleep(1500);
let d0 = dump("STRSEU OPTION(2) 直後（既に先頭ページ）");
if (text(d0).includes("回復")) {
  const sel = d0.fields.filter((f) => !f.protected).pop();
  if (sel) session.setField({ index: sel.index }, "2");
  await session.sendAid("Enter", { timeoutMs: 20000 });
  await sleep(1200);
  d0 = dump("回復画面を2で抜けた後");
}
// 本文行(row8)にカーソルがある体で、既に先頭ページの状態からPageUpを送る
for (let i = 1; i <= 6; i++) {
  await drain(() => session.sendAid("PageUp", { timeoutMs: 15000, cursor: { row: 8, col: 9 } }), `top-PageUp #${i}`);
  dump(`top-PageUp #${i} 後`);
}
session.disconnect?.();
process.exit(0);
