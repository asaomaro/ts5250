// **窓が開いているとき、枠の外に入力欄が残るか**を実機で測る。
//
// `.aidev/backlog/window-detect.md` の「補助条件（入力欄が全て矩形内に収まっているか）」は、
// **枠外に入力欄があれば窓ではない**という判定を足す案。効くかどうかは
// 「本物の窓が開いているとき、背景の入力欄が `snap.fields` に残るか」で決まる——
// **残るなら本物の窓まで殺すので案そのものが没**になる。
//
// 実機の fixture（`test/fixtures/window-stack/`）は**テキストと lastWrite しか持たない**ので、
// この問いは既存の資産では答えられない。だから測りに行く。**読むだけ**。
//
// 実行: node --env-file=.env scripts/diag-window-fields.mjs
import { Session5250 } from "@ts5250/tn5250";

const host = process.env.AS400_HOST;
const user = process.env.AS400_USER;
const password = process.env.AS400_PASSWORD;
if (!host || !user || !password) { process.stderr.write("AS400_* が要ります\n"); process.exit(2); }

const log = (s) => process.stdout.write(s + "\n");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const session = await Session5250.connect({
  host, port: 23, ccsid: 5035, screenSize: "24x80",
  // **装置名は指定しない。** 実機は要求された装置名の自動構成を許していない
  // （8940: Automatic configuration failed or not allowed）。ホストに任せれば QPADEVxxxx が付く
  ...(process.env.AS400_DEVNAME ? { deviceName: process.env.AS400_DEVNAME } : {}),
  warn: () => undefined
});
const text = (s) => s.cells.map((r) => r.map((c) => c.char).join("").replace(/ +$/u, "")).join("\n");

/**
 * 画面と入力欄をそのまま出す。**窓の枠は目で読む**——判定器（web-ui の `detectWindowRect`）は
 * TypeScript のままで node から読めないので、ここでは生の材料だけ出して人が突き合わせる。
 */
const captured = [];
function report(label, snap) {
  const inputs = snap.fields.filter((f) => !f.protected);
  captured.push({
    label,
    rows: snap.rows,
    cols: snap.cols,
    lines: text(snap).split("\n"),
    // **入力欄だけ採る**（この問いに要るのはそれだけ）。値は持たない
    inputs: inputs.map((f) => ({ row: f.row, col: f.col, length: f.length }))
  });
  log(`\n===== ${label} =====`);
  const lines = text(snap).split("\n");
  lines.forEach((l, i) => { if (l.trim()) log(String(i + 1).padStart(2) + "|" + l); });
  log(`  入力欄 ${inputs.length} 個: ` + inputs.map((f) => `r${f.row}c${f.col}(${f.length})`).join(" "));
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
report("メインメニュー（窓なし）", session.snapshot());

// --- ① F1 ヘルプ窓（罫線経路） ---
await session.sendAid("F1", { timeoutMs: 20000 });
await sleep(1500);
report("F1 ヘルプ窓", session.snapshot());
await session.sendAid("F3", { timeoutMs: 15000 });
await sleep(1200);

// --- 一覧画面の上でも見る（背景に入力欄が並ぶ画面） ---
const cmd = session.snapshot().fields.filter((f) => !f.protected).find((f) => f.length > 20);
if (cmd) {
  session.setField({ index: cmd.index }, "WRKOBJPDM LIB(QGPL)");
  await session.sendAid("Enter", { timeoutMs: 25000 });
  await sleep(2000);
  report("WRKOBJPDM（背景。オプション欄が並ぶ）", session.snapshot());
  await session.sendAid("F1", { timeoutMs: 20000 });
  await sleep(1800);
  report("**WRKOBJPDM の上に F1 ヘルプ窓**", session.snapshot());
  await session.sendAid("F3", { timeoutMs: 15000 });
  await sleep(1000);
  await session.sendAid("F3", { timeoutMs: 15000 });
  await sleep(1000);
}
session.disconnect();
if (process.env.WINDIAG_OUT) {
  const { writeFileSync } = await import("node:fs");
  writeFileSync(process.env.WINDIAG_OUT, JSON.stringify(captured, null, 1) + "\n");
  log(`\n(採取: ${process.env.WINDIAG_OUT})`);
}
