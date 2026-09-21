// DSPFMT のオプション入力欄で下線が消える／罫線のみになる不具合の実機調査。
// .aidev/works/20260914-dspfmt-field-underline-instability/requirements.md
//
// 狙う2つの仮説:
//  (a) 黄・青緑以外の色でも、下線と桁区切りの符号化が紛らわしい組み合わせがあるか
//      （packages/tn5250/src/screen/attributes.ts の ATTR_TABLE は 0x20-0x3F の32エントリ
//       しか無く、この帯域には green/white/red/pink/blue の colsep 版が1つも無い——
//       つまりこれらの色で DSPATR(CS) を使うには WEA 等、別経路が要るはず）
//  (b) 窓の開閉・部分再描画で、フィールド属性の打ち切り境界（buffer.ts の retainedEnds/
//      fieldEnds）が正しく引き継がれず、下線が消える（ce3eca64, b98ceae9 と同じ系統）
//
// 実行: node --env-file=.env --env-file=.env.verify scripts/diag-dspfmt-underline.mjs
import { Session5250 } from "@ts5250/tn5250";

const host = process.env.AS400_HOST, user = process.env.AS400_USER, password = process.env.AS400_PASSWORD;
const LIB = process.env.AS400_LIB ?? "TESTLIB";
if (!host || !user || !password) { process.stderr.write("AS400_* が要ります\n"); process.exit(2); }

const log = (s) => process.stdout.write(s + "\n");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const unknownOrders = []; // 「unknown order 0xNN」警告を全部拾う（WEA=0x12 が出るか）

const session = await Session5250.connect({
  host, port: 23, ccsid: 5035, screenSize: "24x80",
  ...(process.env.AS400_DEVNAME ? { deviceName: process.env.AS400_DEVNAME } : {}),
  traceRecords: true,
  warn: (w) => {
    if (/unknown order/.test(w)) unknownOrders.push(w);
    if (/PROTOCOL_ERROR|unmappable/.test(w)) log("WARN: " + w);
  }
});

const text = (s) => s.cells.map((r) => r.map((c) => c.char).join("").replace(/ +$/u, "")).join("\n");

/** 画面中の各セルの色/下線/桁区切りを一覧化する（空白セルは除く） */
function attrDump(snap) {
  const out = [];
  for (let r = 0; r < snap.rows; r++) {
    for (let c = 0; c < snap.cols; c++) {
      const cell = snap.cells[r][c];
      if (!cell || cell.kind === "attr") continue;
      if (cell.char === " " && !cell.underline && !cell.columnSeparator) continue;
      if (cell.underline || cell.columnSeparator || cell.reverse || cell.blink) {
        out.push(`  r${r + 1}c${c + 1} '${cell.char}' color=${cell.color} ul=${cell.underline} cs=${cell.columnSeparator} rev=${cell.reverse} bl=${cell.blink}`);
      }
    }
  }
  return out;
}

function report(label, snap) {
  log(`\n===== ${label} =====`);
  text(snap).split("\n").forEach((l, i) => { if (l.trim()) log(String(i + 1).padStart(2) + "|" + l); });
  const attrs = attrDump(snap);
  log(`  属性付きセル ${attrs.length} 件:`);
  for (const a of attrs) log(a);
}

// --- サインオン〜コマンド行 ---
let snap = session.snapshot();
for (let i = 0; i < 10; i++) {
  const t = text(snap);
  if (t.includes("コマンドを入力") || t.includes("Selection or command")) break;
  const inputs = snap.fields.filter((f) => !f.protected);
  if (t.includes("サイン・オン") || t.includes("Sign On")) {
    if (inputs[0]) session.setField({ index: inputs[0].index }, user);
    if (inputs[1]) session.setField({ index: inputs[1].index }, password);
  } else if (t.includes("回復")) {
    if (inputs[0]) session.setField({ index: inputs[0].index }, "90");
  }
  await session.sendAid("Enter", { timeoutMs: 15000 });
  await sleep(700);
  snap = session.snapshot();
}
log(`コマンド行に到達。ここまでの unknown order: ${unknownOrders.length}`);

async function cmd(cmdText, timeoutMs = 20000) {
  const s = session.snapshot();
  // コマンド行は通常いちばん長い入力欄。取り違えると桁あふれで例外になるので、
  // 収まらない欄しか無ければ諦めて false を返す（呼び出し側でエラー画面回復に回す）。
  const f = s.fields.filter((f) => !f.protected).sort((a, b) => b.length - a.length)[0];
  if (!f || f.length < cmdText.length) { log(`  (コマンド行が見つからない/収まらない: ${f ? f.length : "field無し"} < ${cmdText.length})`); return false; }
  session.setField({ index: f.index }, cmdText);
  await session.sendAid("Enter", { timeoutMs });
  await sleep(1200);
  return true;
}

/** コマンド行に戻れていなければ、エラー画面等を F12/F3 で畳んで復帰を試みる */
async function recoverToCommandLine(maxTries = 4) {
  for (let i = 0; i < maxTries; i++) {
    const t = text(session.snapshot());
    if (t.includes("コマンドを入力") || t.includes("Selection or command")) return true;
    for (const key of ["F12", "F3"]) {
      await session.sendAid(key, { timeoutMs: 8000 }).catch(() => {});
      await sleep(800);
      if (text(session.snapshot()).includes("コマンドを入力")) return true;
    }
  }
  return text(session.snapshot()).includes("コマンドを入力");
}

// --- ① OPTPGM（自前で作った Opt 欄テスト画面。既存なら再利用、無ければスキップ） ---
const optOk = await cmd(`CALL ${LIB}/OPTPGM`);
if (optOk) {
  report("① OPTPGM（Opt 欄テスト、エラーなら次項参照）", session.snapshot());
} else {
  log("① OPTPGM 呼び出しをスキップ（コマンド行が見つからない）");
}
await recoverToCommandLine();

// --- ② WRKOBJPDM（過去に下線バグの実績あり。ce3eca64, b98ceae9） ---
const wrkOk = await cmd(`WRKOBJPDM LIB(${LIB})`, 25000);
if (!wrkOk) { log("WRKOBJPDM の呼び出しに失敗。終了する。"); session.disconnect(); process.exit(1); }
report("② WRKOBJPDM（背景。Opt 欄が並ぶ）", session.snapshot());

// --- ③ その上に F1 ヘルプ窓を開く→閉じる ---
const before = attrDump(session.snapshot());
await session.sendAid("F1", { timeoutMs: 20000 }).catch(() => {});
await sleep(1500);
report("③ WRKOBJPDM の上に F1 ヘルプ窓", session.snapshot());
await session.sendAid("F3", { timeoutMs: 15000 }).catch(() => {});
await sleep(1200);
const after = attrDump(session.snapshot());
report("④ F1 窓を閉じた直後（WRKOBJPDM に戻る）", session.snapshot());

log("\n===== ②→④ の属性セル比較（Opt 欄の下線が消えていないか） =====");
const beforeSet = new Set(before);
const afterSet = new Set(after);
const lost = before.filter((x) => !afterSet.has(x));
const gained = after.filter((x) => !beforeSet.has(x));
log(`  消えた属性セル: ${lost.length} 件`);
lost.forEach((l) => log("  - " + l));
log(`  新たに現れた属性セル: ${gained.length} 件`);
gained.forEach((l) => log("  + " + l));

// --- ⑤ ページ送り（一覧のスクロール＝部分再描画のもう1パターン） ---
await session.sendAid("PageDown", { timeoutMs: 15000 }).catch(() => {});
await sleep(1000);
report("⑤ WRKOBJPDM で PageDown", session.snapshot());

// 後始末
await session.sendAid("F3", { timeoutMs: 10000 }).catch(() => {});
await sleep(500);
await session.sendAid("F3", { timeoutMs: 10000 }).catch(() => {});
session.disconnect();

log(`\n===== unknown order 一覧（WEA=0x12 が含まれるか） =====`);
log(`件数: ${unknownOrders.length}`);
const uniq = [...new Set(unknownOrders)];
uniq.forEach((u) => log("  " + u));
const sawWea = unknownOrders.some((u) => /0x12\b/.test(u));
log(`\nWEA (0x12) 検出: ${sawWea ? "YES — AC6 該当" : "NO"}`);
