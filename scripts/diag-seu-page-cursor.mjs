// **確かめたいこと**: SEU でカーソルがコマンド行(SEU==>)以外（ソース本文中）にある状態から
// PageUp/PageDown した場合、境界ページ（先頭/最終ページ、それ以上スクロールできない状態）到達時に
// ホストが返す WTD に IC/MC（カーソル位置指定オーダー）が含まれるか、含まれてカーソルはどこへ
// 置かれるか。含まれない（または先頭入力欄=SEU==>を指す）なら、それが session.ts:613-616 の
// 「無条件に先頭入力欄へ寄せる」分岐を誤発火させている、という仮説を裏付ける。
//
// 走査検索（F '<文字列>'）でカーソルを本文中の一致箇所へ移動させてから PageDown/PageUp する
// （コマンド行だけが入力欄の browse モードでは、これが本文中へカーソルを移す唯一の手段）。
//
// 対象メンバー: <LIB>/QCLSRC(PAGECURS)（80行、build-pagecurs.mjs で作成）。
// 呼び出し元: .aidev/works/20260914-seu-page-cursor-hold/research.md
//
// 実行: node --env-file=.env --env-file=.env.verify scripts/diag-seu-page-cursor.mjs
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

function hasOrder(hex, orderByte) {
  return hex.split(" ").map((x) => parseInt(x, 16)).includes(orderByte);
}
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

// --- STRSEU で PAGECURS を開く（browse） ---
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

/** SEU==> へ走査検索コマンドを打ち、本文中の一致箇所へカーソルを移す */
async function searchTo(target) {
  const seu = snap().fields.filter((f) => !f.protected)[0];
  session.setField({ index: seu.index }, `F '${target}'`);
  rx.length = 0;
  await session.sendAid("Enter", { timeoutMs: 20000 });
  await sleep(800);
  return dump(`走査検索 '${target}' 直後`);
}

async function page(dir, label) {
  const before = snap().cursor;
  const beforeText = text(snap());
  await drain(() => session.sendAid(dir, { timeoutMs: 15000 }), label);
  const d = dump(`${label} 後`);
  const changed = text(d) !== beforeText;
  log(`  画面変化=${changed}  カーソル ${before.row}/${before.col} -> ${d.cursor.row}/${d.cursor.col}`);
  return { changed, before, after: d.cursor, screen: d };
}

// === ケースA: 前半（LINE 0005）から PageDown を繰り返し、最終ページ（境界）まで進める ===
log("\n########## ケースA: 本文中(LINE 0005)から PageDown で最終ページへ ##########");
await searchTo("LINE 0005");
for (let i = 1; i <= 12; i++) {
  const r = await page("PageDown", `A-PageDown #${i}`);
  if (!r.changed) { log(`  == 最終ページ到達 =={i}`); break; }
}

// === ケースB: 最終ページ付近（LINE 0075）から PageDown で境界を跨ぐ ===
log("\n########## ケースB: 本文中(LINE 0075、最終ページ手前)から PageDown で境界へ ##########");
await searchTo("LINE 0075");
for (let i = 1; i <= 4; i++) {
  const r = await page("PageDown", `B-PageDown #${i}`);
  if (!r.changed) { log(`  == 最終ページ到達 =={i}`); break; }
}

// === ケースC: 後半（LINE 0075）から PageUp を繰り返し、先頭ページ（境界）まで戻す ===
log("\n########## ケースC: 本文中(LINE 0075)から PageUp で先頭ページへ ##########");
await searchTo("LINE 0075");
for (let i = 1; i <= 12; i++) {
  const r = await page("PageUp", `C-PageUp #${i}`);
  if (!r.changed) { log(`  == 先頭ページ到達 =={i}`); break; }
}

session.disconnect?.();
process.exit(0);
