// 画面サイズ設定（24x80 / 27x132）の実機検証。
//
// 5250 では画面サイズを決めるのはホスト側で、クライアントは接続時の telnet 端末タイプ交渉で
// 「この端末はどちらを扱えるか」を申告するだけ。ホストは表示ファイルの DSPSIZ に 27x132（*DS4）版が
// あり、かつ端末が 27x132 対応のときだけ CLEAR UNIT ALTERNATE でワイド画面を送ってくる。
//
// そのため検証には「*DS4 版を持つ画面」が要る。SEU（STRSEU）がそれに当たる。
// 対照として MAIN メニューは *DS3 のみなので、どの端末でも 24x80 のまま来る。
//
// DBCS の端末タイプは RFC 1205 に無く、IBM のドキュメントも 5555 系を一律「24x80 または 27x132」と
// 書くだけでサイズを型番に紐づけていない（tn5250 は DBCS 未実装で先例にならない）。実機で総当たりして
// カラーの 2 つ（24x80=G02 / 27x132=C01）を選んだ経緯があるため、色が落ちていないことも併せて見る
// （B01・G01 を掴むと青/桃/黄が落ちて 4 色になる）。
//
// 実行: node --env-file=.env scripts/verify-screen-size.mjs
import { Session5250 } from "@ts5250/tn5250";

const log = (s) => process.stderr.write(s + "\n");
const creds = { user: process.env.PUB400_USER, password: process.env.PUB400_PASSWORD };
const host = process.env.PUB400_HOST ?? "pub400.com";
const dev = () => "WEBS" + Math.random().toString(36).slice(2, 6).toUpperCase();

const findCmd = (s) => s.fields.find((f) => !f.protected && f.row >= 19) ?? s.fields.find((f) => !f.protected);
const SEU = "STRSEU SRCFILE(TESTLIB/QDDSSRC) SRCMBR(CLRTDSP) OPTION(5)";

/** 期待する対応表（端末タイプと、SEU＝*DS4 画面で実際に来るサイズ） */
const CASES = [
  { screenSize: "24x80", ccsid: 37, term: "IBM-3179-2", seuCols: 80 },
  { screenSize: "27x132", ccsid: 37, term: "IBM-3477-FC", seuCols: 132 },
  { screenSize: "24x80", ccsid: 1399, term: "IBM-5555-G02", seuCols: 80 },
  { screenSize: "27x132", ccsid: 1399, term: "IBM-5555-C01", seuCols: 132 }
];

let ok = true;
const check = (cond, msg) => {
  log(`  ${cond ? "OK  " : "NG  "}${msg}`);
  if (!cond) ok = false;
};

for (const c of CASES) {
  log(`\n===== ${c.screenSize} / CCSID ${c.ccsid} =====`);
  try {
    const s = await Session5250.connect({
      host, port: 23, ccsid: c.ccsid, screenSize: c.screenSize, deviceName: dev(), ...creds
    });
    check(s.terminalType === c.term, `端末タイプ ${s.terminalType}（期待 ${c.term}）`);

    let snap = s.snapshot();
    for (let i = 0; i < 3 && !findCmd(snap); i++) snap = (await s.sendAid("Enter", { timeoutMs: 8000 })).screen;

    // MAIN メニューは *DS3 のみ＝どの端末でも 24x80
    check(snap.cols === 80, `MAIN メニューは 24x80（実際 ${snap.rows}x${snap.cols}）`);

    // SEU は *DS4 を持つ＝27x132 端末でだけワイドで来る
    s.setField({ index: findCmd(snap).index }, SEU);
    snap = (await s.sendAid("Enter", { timeoutMs: 15000 })).screen;
    check(snap.cols === c.seuCols, `SEU は ${c.seuCols} 桁（実際 ${snap.rows}x${snap.cols}）`);
    await s.sendAid("F3", { timeoutMs: 15000 }).catch(() => {});

    // DBCS はカラー端末を掴めているか（モノクロだと 4 色に落ちる）
    if (c.ccsid === 1399) {
      snap = s.snapshot();
      let cur = snap;
      for (let i = 0; i < 3 && !findCmd(cur); i++) cur = (await s.sendAid("Enter", { timeoutMs: 8000 })).screen;
      s.setField({ index: findCmd(cur).index }, "CALL TESTLIB/CLRTPGM");
      cur = (await s.sendAid("Enter", { timeoutMs: 15000 })).screen;
      const colors = new Set();
      for (const row of cur.cells) for (const cell of row) if (cell.color) colors.add(cell.color);
      // 青/桃/黄はモノクロ端末では出ない
      const color = ["blue", "pink", "yellow"].every((x) => colors.has(x));
      check(color, `カラー端末（色 ${[...colors].sort().join("/")}）`);
      await s.sendAid("F3", { timeoutMs: 10000 }).catch(() => {});
    }
    s.disconnect();
  } catch (e) {
    ok = false;
    log(`  NG  ERROR: ${e.message}`);
  }
}

log(ok ? "\n画面サイズ検証: OK" : "\n画面サイズ検証: NG");
process.exit(ok ? 0 : 1);
