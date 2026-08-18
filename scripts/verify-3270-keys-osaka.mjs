// **3270 で IBM i のファンクションキーが効く**ことを実機で確かめる。
//
// IBM i では 3270 の `PFn` は F キーではない——`PF3` は「画面の消去」で、
// F1〜F12 は `PA1` ＋ `PFn`。出典は IBM i 自身の
// 「ヘルプ－ 3270 キーボード・マッピング」画面（3270 で繋いで `PF2`）。
//
// 実行: node --env-file=.env scripts/verify-3270-keys-osaka.mjs
import { Tn3270Session } from "@ts5250/tn3270";

const host = process.env.AS400_HOST;
const user = process.env.AS400_USER;
const password = process.env.AS400_PASSWORD;
if (!host || !user || !password) { process.stderr.write("環境変数が足りません\n"); process.exit(2); }

const log = (s) => process.stdout.write(s + "\n");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
const check = (c, m) => { if (c) { pass++; log(`  PASS ${m}`); } else { fail++; log(`  FAIL ${m}`); } };

const s = new Tn3270Session({ host, port: 23, ccsid: Number(process.env.AS400_CCSID ?? 930) });
await s.connect(); await sleep(2500);
const L = () => s.snapshot().cells.map((r) => r.map((c) => c.char).join("").replace(/\s+$/u, ""));
const head = () => L().find((t) => t.trim() !== "")?.trim().slice(0, 44) ?? "";
const rejected = () => L().some((t) => t.includes("できません"));
const cmdField = () => s.snapshot().fields.filter((x) => !x.protected).find((x) => x.row >= 19);
const toMenu = async () => {
  for (let i = 0; i < 4 && !head().includes("メインメニュー"); i++) {
    await s.sendFunctionKey(12).catch(() => undefined); await sleep(2500);
    if (!head().includes("メインメニュー")) { s.send("enter"); await sleep(2500); }
  }
};

log("### 1. ホストの見分け");
check(s.isIbmI, `NEW-ENVIRON を交渉した＝IBM i と判定（isIbmI=${s.isIbmI}）`);
check(!s.isTn3270e, `TN3270E ではない（isTn3270e=${s.isTn3270e}）——見分けに使えないことの確認`);

const f = s.snapshot().fields.filter((x) => !x.protected);
s.setCursor(f[0].row, f[0].col); s.type(user);
s.setCursor(f[1].row, f[1].col); s.type(password);
s.send("enter"); await sleep(4000);
s.send("enter"); await sleep(4000);
check(head().includes("メインメニュー"), `サインオンしてメニューに着いた（${head()}）`);

log("\n### 2. F キー");
{
  const c = cmdField(); if (c) { s.setCursor(c.row, c.col); s.type("WRKACTJOB"); }
  await s.sendFunctionKey(4); await sleep(5000);
  check(head().includes("活動ジョブ処理"), `**F4（プロンプト）が効く** → ${head()}`);
  check(!rejected(), "「機能キーは使用できません」が出ない");
  await s.sendFunctionKey(12); await sleep(4000);
  check(head().includes("メインメニュー"), `**F12（取り消し）が効く** → ${head()}`);
}
{
  await s.sendFunctionKey(13); await sleep(4000);
  check(head().includes("情報援助"), `**F13（情報援助）が効く** → ${head()}`);
  await toMenu();
}

log("\n### 3. ページ送り（素の PF7 / PF8）");
{
  const c = cmdField(); if (c) { s.setCursor(c.row, c.col); s.type("WRKACTJOB"); }
  s.send("enter"); await sleep(6000);
  const before = L().join("");
  s.send("pf8"); await sleep(4000);
  check(L().join("") !== before, "PF8 で次ページへ進む");
  check(!rejected(), "拒否されない");
  await s.sendFunctionKey(3); await sleep(4000);
  check(head().includes("メインメニュー"), `**F3（終了）が効く** → ${head()}`);
}

log(`\n${pass} PASS / ${fail} FAIL`);
s.close?.();
process.exit(fail === 0 ? 0 : 1);
