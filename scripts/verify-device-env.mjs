// 実機検証（tn5250）: **KBDTYPE / CODEPAGE / CHARSET の申告で、サインオンと日本語の往復が通るか**。
//
// `20260921-device-env-1399`: 1399 の申告を ACS と同じ JPE・1027・32000 にした（以前は JEB・1172）。
// 手順: 指定の CCSID で繋ぐ → サインオン画面の欄へ直接書いてサインオン → コマンド行に日本語を打って Enter →
//       ホストの「コマンドが見つからない」系のメッセージに、打った日本語がそのまま戻るかを見る → SIGNOFF。
//       **ホストに何も作らない**（存在しないコマンドを打つだけ）。
//
// 実行: node --env-file=.env --env-file=.env.verify scripts/verify-device-env.mjs [PUB400|AS400] [CCSID]
//   <接頭辞>_USER / _PASSWORD（`.env`）。<接頭辞>_HOST（PUB400 だけ既定 pub400.com）。CCSID の既定は 1399。
//   装置名は <接頭辞>_DEVNAME（無ければ指定しない＝ホストに採らせる）。
// **画面の行は出さない**（システム名などの実機の識別子を含むので）。判定だけを出す。
import { Session5250 } from "@ts5250/tn5250";

const prefix = process.argv[2] ?? "PUB400";
const ccsid = Number(process.argv[3] ?? 1399);
const host = process.env[`${prefix}_HOST`] ?? (prefix === "PUB400" ? "pub400.com" : undefined);
const user = process.env[`${prefix}_USER`];
const password = process.env[`${prefix}_PASSWORD`];
if (!host || !user || !password) {
  process.stderr.write(`${prefix}_USER / ${prefix}_PASSWORD（と ${prefix}_HOST）が要ります（.env）\n`);
  process.exit(2);
}
const log = (s) => process.stderr.write(s + "\n");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const text = (snap) => snap.cells.map((r) => r.map((c) => c.char).join("")).join("\n");
const inputs = (snap) => snap.fields.filter((f) => !f.protected);
const cmdLine = (snap) => inputs(snap).find((f) => f.length >= 50);
const deviceName = process.env[`${prefix}_DEVNAME`] || undefined;
let pass = 0, fail = 0;
const check = (c, m) => { if (c) { pass++; log(`  PASS ${m}`); } else { fail++; log(`  FAIL ${m}`); } };

const s = await Session5250.connect({ host, ccsid, ...(deviceName ? { deviceName } : {}) });
await sleep(1000);
let snap = s.snapshot();
const [u, p] = inputs(snap);
s.setField({ index: u.index }, user);
s.setField({ index: p.index }, password);
await s.sendAid("Enter", { cursor: { row: u.row, col: u.col }, timeoutMs: 15000 });
for (let i = 0; i < 5; i++) {
  await sleep(800);
  snap = s.snapshot();
  if (cmdLine(snap)) break;
  if (/対話式ジョブの回復|Attempt to recover interactive job/.test(text(snap))) {
    const f = inputs(snap).slice(-1)[0];
    s.setField({ index: f.index }, "90");
    await s.sendAid("Enter", { cursor: { row: f.row, col: f.col }, timeoutMs: 12000 });
  } else await s.sendAid("Enter", { timeoutMs: 10000 }).catch(() => {});
}
snap = s.snapshot();
check(cmdLine(snap) !== undefined && !snap.fields.some((f) => f.hidden && !f.protected), `CCSID ${ccsid} でサインオンできた（${prefix}）`);

// 日本語を打って Enter——存在しないコマンドなので、ホストはその名前をメッセージに入れて返す
const probe = "ニホンゴ漢字";
const f = cmdLine(snap);
if (f) {
  s.setField({ index: f.index }, probe);
  await s.sendAid("Enter", { cursor: { row: f.row, col: f.col }, timeoutMs: 15000 }).catch(() => {});
  await sleep(1000);
  snap = s.snapshot();
  const all = text(snap) + "\n" + (snap.systemMessage ?? "");
  check(all.includes("漢字"), "打った日本語がホストのメッセージに戻った（DBCS の往復）");
  // 片付け
  const g = cmdLine(snap);
  if (g) {
    await s.sendAid("Enter", { timeoutMs: 5000 }).catch(() => {});
    s.setField({ index: g.index }, "SIGNOFF");
    await s.sendAid("Enter", { cursor: { row: g.row, col: g.col }, timeoutMs: 10000 }).catch(() => {});
  }
}
await sleep(500);
s.disconnect();
log(`RESULT: pass=${pass} fail=${fail}`);
process.exit(fail > 0 ? 1 : 0);
