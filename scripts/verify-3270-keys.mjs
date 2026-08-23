// **3270 で IBM i のファンクションキーが効く**ことを実機で確かめる。
//
// IBM i では 3270 の `PFn` は F キーではない——`PF3` は「画面の消去」で、
// F1〜F12 は `PA1` ＋ `PFn`。出典は IBM i 自身の
// 「ヘルプ－ 3270 キーボード・マッピング」画面（3270 で繋いで `PF2`）。
//
// 実行: node --env-file=.env --env-file=.env.verify scripts/verify-3270-keys.mjs
//       PROBE=PUB400 を付けると pub400 に当たる（**画面が英語**なので目印を両対応にしてある）
//
// ⚠ **1 台で確かめて一般化しない。** 装置名では 2 台の IBM i が違う答えを返した
// （pub400 は受け入れ、社内機は接続を切る）。キーの対応表は IBM i 共通のはずだが、
// **確かめるまでは分からない**ので両方に当てられるようにしてある。
import { Tn3270Session } from "@ts5250/tn3270";

const PRE = process.env.PROBE === "PUB400" ? "PUB400" : "AS400";
const host = process.env[`${PRE}_HOST`];
const user = process.env[`${PRE}_USER`];
const password = process.env[`${PRE}_PASSWORD`];
if (!host || !user || !password) { process.stderr.write(`${PRE}_HOST / _USER / _PASSWORD が要ります\n`); process.exit(2); }

/** 画面の目印。**pub400 は英語**なので、日本語と英語の両方を見る */
const M = {
  menu: /メインメニュー|Main Menu/u,
  wrkactjob: /活動ジョブ処理|Work with Active Jobs/u,
  info: /情報援助|Information Assist/u,
  rejected: /できません|not allowed|not valid/iu,
  help: /ヘルプ|Help/u,
  print: /印刷操作|[Pp]rint operation|印刷/u,
  sysreq: /システム要求|System Request/u,
  attn: /コマンド入力|Command Entry/u,
  /** 注意プログラム。ホストの設定（ATNPGM）次第で何も出ないことがある */
  atnAny: /コマンド入力|Command Entry|援助|Assist/u
};

const log = (s) => process.stdout.write(s + "\n");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
const check = (c, m) => { if (c) { pass++; log(`  PASS ${m}`); } else { fail++; log(`  FAIL ${m}`); } };

const s = new Tn3270Session({ host, port: 23, ccsid: Number(process.env.PROBE_CCSID ?? (PRE === "PUB400" ? 37 : 930)) });
await s.connect(); await sleep(2500);
const L = () => s.snapshot().cells.map((r) => r.map((c) => c.char).join("").replace(/\s+$/u, ""));
const head = () => L().find((t) => t.trim() !== "")?.trim().slice(0, 44) ?? "";
const rejected = () => L().some((t) => M.rejected.test(t));
const cmdField = () => s.snapshot().fields.filter((x) => !x.protected).find((x) => x.row >= 19);
/**
 * メインメニューに素の状態で戻っているか。
 *
 * ⚠ **先頭行では判定できない**——ヘルプは*窓*で重なるので、開いていても先頭行は
 * 「MAIN … メインメニュー」のまま。窓の中身まで見ないと「戻った」を誤判定する
 * （最初これで、ヘルプを開いたまま次のキーを試していた）。
 */
const atMenu = () =>
  M.menu.test(head()) &&
  !L().some((t) =>
    /ヘルプ|システム要求|コマンド入力|印刷操作|Help|System Request|Command Entry|Operational Assistant/u.test(t)
  );
const toMenu = async () => {
  for (let i = 0; i < 5 && !atMenu(); i++) {
    await s.sendFunctionKey(12).catch(() => undefined); await sleep(2500);
    if (!atMenu()) { await s.sendFunctionKey(3).catch(() => undefined); await sleep(2500); }
    if (!atMenu()) { s.send("enter"); await sleep(2500); }
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
check(M.menu.test(L().join("\n")), `サインオンしてメニューに着いた（${head()}）`);

log("\n### 2. F キー");
{
  const c = cmdField(); if (c) { s.setCursor(c.row, c.col); s.type("WRKACTJOB"); }
  await s.sendFunctionKey(4); await sleep(5000);
  check(M.wrkactjob.test(L().join("\n")), `**F4（プロンプト）が効く** → ${head()}`);
  check(!rejected(), "「機能キーは使用できません」が出ない");
  await s.sendFunctionKey(12); await sleep(4000);
  check(M.menu.test(L().join("\n")), `**F12（取り消し）が効く** → ${head()}`);
}
{
  await s.sendFunctionKey(13); await sleep(4000);
  check(M.info.test(L().join("\n")), `**F13（情報援助）が効く** → ${head()}`);
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
  check(M.menu.test(L().join("\n")), `**F3（終了）が効く** → ${head()}`);
}

log("\n### 4. IBM i でだけ割り当てのあるキー");
{
  // ⚠ **先頭行だけを見ると取りこぼす**。SysReq は 24 行目に入力行が出るだけで、
  // 先頭行は変わらない。画面全体で突き合わせること（最初これで見落とした）
  const whole = () => L().join("\n");

  await toMenu();
  {
    const before = whole();
    s.send("pf1"); await sleep(4000);   // Help
    check(
      whole() !== before && L().some((t) => M.help.test(t)),
      `**Help（PF1）が効く** → ${L().find((t) => M.help.test(t))?.trim().slice(0, 44)}`
    );
    await toMenu();
  }
  {
    const before = whole();
    s.send("pf4"); await sleep(4000);   // Print
    check(
      whole() !== before && L().some((t) => M.print.test(t)),
      `**Print（PF4）が効く** → ${L().find((t) => M.print.test(t))?.trim().slice(0, 44)}`
    );
    await toMenu();
  }
  {
    s.send("pf11"); await sleep(3000);  // SysReq → 入力行が出る
    s.send("enter"); await sleep(3500); // → システム要求メニュー
    check(
      L().some((t) => M.sysreq.test(t)),
      `**SysReq（PF11）が効く** → ${L().find((t) => M.sysreq.test(t))?.trim().slice(0, 44)}`
    );
    s.send("pf3"); await sleep(3000);
    await toMenu();
  }
  {
    // ⚠ **出る画面はシステム次第**（注意プログラム＝ATNPGM）。実測:
    //   社内機 → 「EVXX01 コマンド入力」 ／ pub400 → 「Operational Assistant (ASSIST) Menu」
    // だから**画面が変わったこと**で判定する。特定の題名を当てにしない
    const before = whole();
    s.send("pf9"); await sleep(4500);
    check(
      whole() !== before && !rejected(),
      `**Attn（PF9）が効く**（注意プログラムが開く） → ${head()}`
    );
    await s.sendFunctionKey(3).catch(() => undefined); await sleep(3000);
    await toMenu();
  }
}

log(`\n${pass} PASS / ${fail} FAIL`);
s.close?.();
process.exit(fail === 0 ? 0 : 1);
