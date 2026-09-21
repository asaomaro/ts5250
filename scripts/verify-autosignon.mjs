// T13: RFC 4777 NEW-ENVIRON 自動サインオンの実機検証（decisions.md D3）。
// `20260921-telnet-signon-vars` で IBMRSEED を ACS と同じく値なしにした（以前は ESC＋8 バイトの 0）。両方の実機で通ることを見る。
// `20260921-encrypted-autosignon`: 既定は ACS と同じ**暗号化**（代替パスワード。サーバーの `bypassSubstituteFor`。QPWDLVL はサインオン・
// サーバーに聞く）。3 番目の引数に `clear` を渡すと従来の平文で送る（比べるとき用）。
//
// 実行: npm run build && node --env-file=.env --env-file=.env.verify scripts/verify-autosignon.mjs [PUB400|AS400] [clear]
//   <接頭辞>_USER / _PASSWORD（`.env`）。<接頭辞>_HOST（`.env`。PUB400 だけ既定 pub400.com）。
//   装置名は <接頭辞>_DEVNAME（`.env.verify`）。PUB400 の既定は WEBEMU01、AS400 は指定しない（ホストに採らせる。
//   この機は新しい名前の自動構成を許さない）。CCSID は AS400 が 930、PUB400 が 37（AS400_CCSID で上書き）。
// **画面の行は出さない**（システム名などの実機の識別子を含むので）。判定と、拒否されたときのメッセージ ID だけを出す。
import { Session5250 } from "@ts5250/tn5250";
import { bypassSubstituteFor } from "../packages/server/dist/session-manager.js";

const prefix = process.argv[2] ?? "PUB400";
const host = process.env[`${prefix}_HOST`] ?? (prefix === "PUB400" ? "pub400.com" : undefined);
const user = process.env[`${prefix}_USER`];
const password = process.env[`${prefix}_PASSWORD`];
if (!host || !user || !password) {
  process.stderr.write(`${prefix}_USER / ${prefix}_PASSWORD（と ${prefix}_HOST）が要ります（.env）\n`);
  process.exit(2);
}
const log = (s) => process.stderr.write(s + "\n");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const screenText = (snap) => snap.cells.map((r) => r.map((c) => c.char).join("")).join("\n");
const deviceName = process.env[`${prefix}_DEVNAME`] || (prefix === "PUB400" ? "WEBEMU01" : undefined);
const ccsid = Number(process.env[`${prefix}_CCSID`] ?? (prefix === "AS400" ? 930 : 37));

const clear = process.argv[3] === "clear";
const session = await Session5250.connect({
  host,
  port: 23,
  ccsid,
  ...(deviceName ? { deviceName } : {}),
  user,
  password,
  ...(clear ? {} : { passwordSubstitute: bypassSubstituteFor({ host, user, password }) }),
  warn: (w) => log("WARN: " + w)
});
log(`送り方: ${clear ? "平文" : "暗号化（代替パスワード）"}`);
await sleep(1500);

// パスワード欄（非表示の入力欄）が残っていればサインオン画面のまま＝自動サインオン不成立
const signonScreen = (snap) => snap.fields.some((f) => f.hidden && !f.protected);
const cmdLine = (snap) => snap.fields.find((f) => !f.protected && f.length >= 50);
let snap = session.snapshot();
const rejected = /CPF\d{4}/.exec(screenText(snap))?.[0];
const ok = !signonScreen(snap) && rejected === undefined;
if (ok) log(`T13: OK — 自動サインオンが通った（${prefix}）`);
else if (rejected) log(`T13: NG — 資格情報が拒否された（${rejected}）`);
else log(`T13: NG — サインオン画面のまま（自動サインオン不成立。${prefix}）`);

// 片付け: コマンド行が出るまで Enter（サインオン情報などの画面）→ SIGNOFF
if (ok) {
  for (let i = 0; i < 4 && !cmdLine(snap); i++) {
    await session.sendAid("Enter", { timeoutMs: 10000 }).catch(() => {});
    await sleep(800);
    snap = session.snapshot();
  }
  const f = cmdLine(snap);
  if (f) {
    session.setField({ index: f.index }, "SIGNOFF");
    await session.sendAid("Enter", { cursor: { row: f.row, col: f.col }, timeoutMs: 10000 }).catch(() => {});
    await sleep(800);
  }
}
session.disconnect();
process.exit(ok ? 0 : 1);
