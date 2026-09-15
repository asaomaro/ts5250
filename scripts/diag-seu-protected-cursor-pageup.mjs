// **利用者の再現手順を実機でそのままなぞる**:
//   1. 任意のソース（PAGECURS）を browse で開く。
//   2. 10桁10行目など、入力不可（保護欄）の位置へカーソルを設定する
//      （矢印キー相当。ホストへは送らず、次の AID の cursor オプションとして申告する）。
//   3. PageUp を押下する。
//   4. カーソルがヘッダーの入力可能エリアへ強制移動するか確認する。
//
// 利用者の報告: ACS ではこの操作でカーソル位置が変わらない。
// .aidev/works/20260915-pdm-protected-cursor-pageup/requirements.md
//
// 実行: node --env-file=.env --env-file=.env.verify scripts/diag-seu-protected-cursor-pageup.mjs
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

// **`hasOrder`（生バイトの雑な検索）は信用できない**——SBA の行・桁パラメータ等、
// テキストデータの一部としてたまたま IC(0x13)/MC(0x14) と同じ値のバイトが出現しうる
// （偽陽性）。真に信頼できる判定は、クライアント自身の `cursorToFirstInputField()`
// （`!cursorSet` 時の既定動作）が実際に呼ばれたかどうかを直接計装することで得る。
let cursorToFirstCalls = 0;
const origCursorToFirst = session.buf.cursorToFirstInputField.bind(session.buf);
session.buf.cursorToFirstInputField = (...args) => {
  cursorToFirstCalls++;
  log(`  >>> buf.cursorToFirstInputField() が呼ばれた（!cursorSet の可能性）`);
  return origCursorToFirst(...args);
};
// **重要な確認**: PageUp/PageDown の応答は clearUnit()（cursorAddr を 0 にリセットする）を
// 伴うか？ 伴うなら、`!cursorSet`/`PR#387` の分岐を抑止するだけの修正では、
// resize() のリセットに上書きされてしまい、修正が機能しない可能性がある。
let clearUnitCalls = 0;
const origClearUnit = session.buf.clearUnit.bind(session.buf);
session.buf.clearUnit = (...args) => {
  clearUnitCalls++;
  const rBefore = session.buf.cursorAddr;
  const ret = origClearUnit(...args);
  log(`  >>> buf.clearUnit() が呼ばれた（直前 cursorAddr=${rBefore} → 直後 cursorAddr=${session.buf.cursorAddr}）`);
  return ret;
};
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
function isEnterable(s, row, col) {
  // 現在のカーソル位置(row,col)が入力可能な欄に含まれるかを、snapshot の fields から判定する
  const f = s.fields.find((f) =>
    !f.protected && f.row === row && col >= f.col && col < f.col + f.length
  );
  return !!f;
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

// --- STRSEU で PAGECURS を browse で開く（OPTION(5)） ---
{
  const c = cmdField();
  session.setField({ index: c.index }, `STRSEU SRCFILE(${LIB}/QCLSRC) SRCMBR(PAGECURS) OPTION(5)`);
  rx.length = 0;
  await session.sendAid("Enter", { timeoutMs: 25000 });
  await sleep(1500);
  let d = dump("STRSEU OPTION(5) 直後");
  if (text(d).includes("回復")) {
    const sel = d.fields.filter((f) => !f.protected).pop();
    if (sel) session.setField({ index: sel.index }, "2");
    await session.sendAid("Enter", { timeoutMs: 20000 });
    await sleep(1200);
    dump("回復画面を2で抜けた後");
  }
}

async function tryAt(label, target, dir) {
  session.buf.cursorAddr = session.buf.addrOf(target.row, target.col);
  const before = dump(`[${label}] カーソルを手動で r${target.row}c${target.col} へ移動した直後（ホストへは未送信）`);
  log(`  isEnterable(r${target.row}c${target.col})=${isEnterable(before, target.row, target.col)}`);
  const callsBefore = cursorToFirstCalls;
  const clearBefore = clearUnitCalls;
  const r = await drain(() => session.sendAid(dir, { timeoutMs: 15000, cursor: target }), `${label}-${dir}`);
  const after = dump(`[${label}] ${dir} 後`);
  log(`  送信前カーソル: ${target.row}/${target.col}（保護欄）`);
  log(`  受信後カーソル: ${after.cursor.row}/${after.cursor.col}`);
  log(`  カーソルが動いたか: ${after.cursor.row !== target.row || after.cursor.col !== target.col}`);
  log(`  受信後の位置は入力可能か: ${isEnterable(after, after.cursor.row, after.cursor.col)}`);
  log(`  ホストが IC/MC を送ってきたか（雑な検索・参考値）: IC=${r.ic} MC=${r.mc}`);
  log(`  cursorToFirstInputField() が呼ばれたか（信頼できる判定）: ${cursorToFirstCalls > callsBefore}`);
  log(`  clearUnit() が呼ばれたか（信頼できる判定）: ${clearUnitCalls > clearBefore}`);
  return { before, after, r };
}

// === ケース1: 境界（先頭ページ、これ以上 PageUp できない）で保護欄からの PageUp ===
log("\n########## ケース1: 境界（先頭ページ）で保護欄から PageUp ##########");
await tryAt("境界", { row: 10, col: 10 }, "PageUp");

// === ケース2: 非境界（PageDown で中間ページへ進めてから）で保護欄からの PageUp/PageDown ===
log("\n########## ケース2: 非境界（中間ページ）で保護欄から PageDown ##########");
await drain(() => session.sendAid("PageDown", { timeoutMs: 15000 }), "助走PageDown#1");
await drain(() => session.sendAid("PageDown", { timeoutMs: 15000 }), "助走PageDown#2");
dump("中間ページへ移動後");
await tryAt("非境界-PageDown", { row: 10, col: 10 }, "PageDown");

log("\n########## ケース3: 非境界（中間ページ）で保護欄から PageUp（境界に戻らない範囲） ##########");
await tryAt("非境界-PageUp", { row: 10, col: 10 }, "PageUp");

// --- 比較用: PR#387 の本来のシナリオ（Enter で確定→保護化）が引き続き動くか ---
// ここでは別のテスト画面が必要なため、簡易的に既存のフィールドが無ければスキップする。
log(`\n(PR#387 の回帰確認は既存の cursor-stale-on-protected.test.ts / diag-cursor-after-expand.mjs を別途参照)`);

session.disconnect?.();
process.exit(0);
