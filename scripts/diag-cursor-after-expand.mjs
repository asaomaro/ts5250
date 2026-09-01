// 「上で入力 → Enter → 上がプロテクト、下が展開」の画面で、
// **ホストが指したカーソル位置に付くか**を実機で測る（利用者報告の再現）。
//
// 画面は `scripts/build-cursortst.mjs` が作る <LIB>/CURSORCL。
// 2 画面目は DDS の `DSPATR(PC)` で NAME（10 行 12 桁）を指している。
//
// 読むだけ。オブジェクトは作らない。
// 実行: node --env-file=.env --env-file=.env.verify scripts/diag-cursor-after-expand.mjs
import { Session5250 } from "@ts5250/tn5250";

const host = process.env.AS400_HOST;
const user = process.env.AS400_USER;
const password = process.env.AS400_PASSWORD;
const LIB = process.env.AS400_LIB ?? "TESTLIB";
if (!host || !user || !password) { process.stderr.write("AS400_* が要ります\n"); process.exit(2); }

const log = (s) => process.stdout.write(s + "\n");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const text = (s) => s.cells.map((r) => r.map((c) => c.char).join("").replace(/ +$/u, "")).join("\n");

const session = await Session5250.connect({
  host, port: 23, ccsid: 5035, screenSize: "24x80",
  ...(process.env.AS400_DEVNAME ? { deviceName: process.env.AS400_DEVNAME } : {}),
  warn: () => undefined
});

function report(label) {
  const snap = session.snapshot();
  const inputs = snap.fields.filter((f) => !f.protected);
  log(`\n===== ${label} =====`);
  text(snap).split("\n").forEach((l, i) => { if (l.trim()) log(String(i + 1).padStart(2) + "|" + l); });
  log(`  カーソル: ${snap.cursor.row}/${snap.cursor.col}`);
  log(`  入力欄 ${inputs.length} 個: ` + inputs.map((f) => `r${f.row}c${f.col}(${f.length})`).join(" "));
  return { snap, inputs };
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

// --- テスト画面を呼ぶ ---
const cmd = session.snapshot().fields.filter((f) => !f.protected).find((f) => f.length > 20);
if (!cmd) { log("コマンド行が見つからない"); process.exit(1); }
session.setField({ index: cmd.index }, `CALL ${LIB}/${process.env.PGM ?? "CURSORCL"}`);
await session.sendAid("Enter", { timeoutMs: 25000 });
await sleep(1500);

const first = report("1 画面目（上だけ入力可）");
// 上の欄に打って Enter
const top = first.inputs[0];
if (top) session.setField({ index: top.index }, "ABC123");
await session.sendAid("Enter", { timeoutMs: 25000 });
await sleep(1800);

const second = report("2 画面目（上プロテクト・下が展開）");
const c = second.snap.cursor;
const name = second.inputs.find((f) => f.row === 10);
log("");
log(`  期待: ホストの DSPATR(PC) が指す NAME（10/12）にカーソルが付く`);
log(`  実際: ${c.row}/${c.col}  → ${c.row === 10 && c.col === 12 ? "一致（再現せず）" : "**ずれている（再現）**"}`);
log(`  下の入力欄: ${name ? `r${name.row}c${name.col}` : "見つからない"}`);

await session.sendAid("F3", { timeoutMs: 15000 }).catch(() => {});
await sleep(500);
session.close?.();
process.exit(0);
