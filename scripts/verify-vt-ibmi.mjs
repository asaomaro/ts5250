// **IBM i に VT で繋いでサインオンまで通す。**
//
// IBM i の TELNET サーバーは 5250 / 3270 に加えて **VT100 / VT220 を受ける**。
// 5250 のパネルを ANSI エスケープに翻訳して送ってくる（research 1.2）。
//
// ⚠ **ホストの構成によっては画面が来ない。** SR-OSAKA は交渉まで進むが
// サブシステムが仮想装置をオフにするため（QSYSOPR に CPF1194）画面が 1 バイトも来ない。
// **pub400 では動く。** 1 台で一般化しないこと（3270 の装置名で 1 度間違えている）。
//
// ⚠ **サインオンの失敗は数える。** QMAXSIGN は pub400=5 / SR-OSAKA=3。
//
// 実行: node --env-file=.env scripts/verify-vt-ibmi.mjs
//       PROBE=AS400 を付けると社内機に当たる（画面が来ないことの確認になる）
import { VtSession } from "@ts5250/vt";

const PRE = process.env.PROBE === "AS400" ? "AS400" : "PUB400";
const host = process.env[`${PRE}_HOST`];
const user = process.env[`${PRE}_USER`];
const password = process.env[`${PRE}_PASSWORD`];
if (!host || !user || !password) {
  process.stderr.write(`${PRE}_HOST / _USER / _PASSWORD が要ります\n`);
  process.exit(2);
}
// pub400 は QCCSID=273、社内機は日本語。**申告しないと記号入りのパスワードが化けて CPF1120**
const ccsid = Number(process.env.VT_CCSID ?? (PRE === "PUB400" ? 37 : 930));

const log = (s) => process.stdout.write(s + "\n");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
const check = (c, m) => { if (c) { pass++; log(`  PASS ${m}`); } else { fail++; log(`  FAIL ${m}`); } };

const s = await VtSession.connect({
  host,
  port: 23,
  rows: 24,
  cols: 80,
  // **IBM i には VT220**。xterm 系の名前は知らないので SEND を繰り返される（research 1.1）
  terminalTypes: ["VT220"],
  ccsid
});
const screen = () => s.snapshot().cells
  .map((r) => r.map((c) => (c.width === 0 ? "" : c.char)).join("").replace(/ +$/u, ""))
  .join("\n");
let closed = "";
s.on("close", (r) => { closed = r; });

try {
  await sleep(4000);
  log(`\n[1] 交渉（${PRE}）`);
  check(s.isIbmI, "**DO NEW-ENVIRON で IBM i と判定**した");
  check(s.terminalType === "VT220", "VT220 を申告した（SEND は 1 回で済んだ）");
  check(s.hostEchoes, "ホストが ECHO を握った");

  const signon = screen();
  if (signon.trim() === "") {
    log("\n  ⚠ **画面が 1 バイトも来ていない。**");
    log("     ホスト側で VT の仮想装置にジョブが割り当てられていない可能性がある");
    log("     （QSYSOPR に CPF1194 が出ていないか確認する。research 1.2 の SR-OSAKA がこれ）");
    check(false, "サインオン画面が届く");
    log(`\n==== ${pass} PASS / ${fail} FAIL ====`);
    s.close();
    process.exit(1);
  }

  log("\n[2] サインオン画面");
  check(/Sign On|サインオン|User|ユーザー|user name/iu.test(signon), "サインオン画面が届く");
  check(/Display name|表示装置|QPADEV/iu.test(signon), "仮想装置が割り当たっている");

  log("\n[3] サインオン（**失敗は QMAXSIGN に数えられる**ので 1 回だけ）");
  s.text(user);
  await sleep(600);
  s.key({ key: "Tab" });
  await sleep(900);
  s.text(password);
  await sleep(600);
  s.key({ key: "Enter" });
  await sleep(7000);
  let after = screen();
  if (/Press Enter|継続するには/iu.test(after)) { s.key({ key: "Enter" }); await sleep(4000); after = screen(); }
  check(!/CPF1120/u.test(after), "**CPF1120 が出ない**（NEW-ENVIRON のコードページ申告が効いている）");
  check(/Main Menu|メインメニュー|MAIN/u.test(after), "IBM i のメインメニューに到達した");

  log("\n[4] コマンドを打って戻る");
  s.text("DSPLIBL");
  await sleep(500);
  s.key({ key: "Enter" });
  await sleep(5000);
  check(/Library List|ライブラリー・リスト|QSYS/iu.test(screen()), "DSPLIBL が実行できた");
  // F3 で戻る（IBM i の VT では F3 は `ESC O R` 系ではなく PF キーの割り当てに依る）
  s.key({ key: "F3" });
  await sleep(3000);
  log(`  （F3 のあとの先頭行: ${screen().split("\n").find((l) => l.trim()) ?? "(空)"}）`);

  log("\n[5] サインオフ");
  s.text("SIGNOFF");
  await sleep(400);
  s.key({ key: "Enter" });
  await sleep(3000);
  check(true, "サインオフを送った");
} finally {
  log(`\n==== ${pass} PASS / ${fail} FAIL ====`);
  if (closed) log(`（切断の理由: ${closed}）`);
  s.close();
  process.exit(fail === 0 ? 0 : 1);
}
