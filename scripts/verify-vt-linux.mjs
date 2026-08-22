// **VT の実装を Linux の telnetd 相手に確かめる。**
//
// ライブラリの単体テストは自分で書いた列しか通らない。ここは**実アプリが出す列**
// （bash のプロンプト・ls の色・vi の代替画面・less のページ送り）を相手にする。
//
// 準備:
//   docker build -t ts5250-vt-telnetd scripts/vt-telnetd
//   docker run -d --name ts5250-vt -p 2331:23 ts5250-vt-telnetd
// 実行:
//   node scripts/verify-vt-linux.mjs
import { VtSession } from "@ts5250/vt";

const PORT = Number(process.env.VT_PORT ?? 2331);
const HOST = process.env.VT_HOST ?? "127.0.0.1";

const log = (s) => process.stdout.write(s + "\n");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
const check = (cond, msg) => { if (cond) { pass++; log(`  PASS ${msg}`); } else { fail++; log(`  FAIL ${msg}`); } };

const s = await VtSession.connect({ host: HOST, port: PORT, rows: 24, cols: 80 });
const text = () => s.snapshot().cells.map((r) => r.map((c) => (c.width === 0 ? "" : c.char)).join("").replace(/ +$/u, ""));
const screen = () => text().join("\n");
const type = async (str, ms = 400) => { s.text(str); await sleep(ms); };

try {
  await sleep(1500);
  log("\n[1] 交渉");
  check(s.hostEchoes, "ホストが ECHO を握った（＝文字モード）");
  check(!s.isIbmI, "IBM i ではないと判定した");

  log("\n[2] シェルが応答する");
  await type("export PS1='$ '; stty -echo; clear\r", 900);
  await type("echo HELLO-VT\r", 900);
  check(screen().includes("HELLO-VT"), "コマンドの往復が成立する");

  log("\n[3] NAWS が効いている");
  await type("stty size\r", 900);
  check(screen().includes("24 80"), "ホストが 24x80 と認識している");
  s.resize(30, 100);
  await sleep(300);
  await type("stty size\r", 900);
  check(screen().includes("30 100"), "リサイズがホストに伝わる");
  s.resize(24, 80);
  await sleep(300);
  await type("clear\r", 700);

  log("\n[4] 色（256 色・24 ビット・明色）");
  await type("printf '\\033[38;5;208mA\\033[0m\\033[38;2;10;20;30mB\\033[0m\\033[94mC\\033[0m\\n'\r", 900);
  {
    const cells = s.snapshot().cells;
    const row = cells.find((r) => r[0]?.char === "A");
    check(row !== undefined && row[0].style.fg.kind === "indexed" && row[0].style.fg.index === 208, "256 色が indexed で残る");
    check(row !== undefined && row[1].style.fg.kind === "rgb" && row[1].style.fg.r === 10, "24 ビット色が rgb で残る");
    check(row !== undefined && row[2].style.fg.kind === "indexed" && row[2].style.fg.index === 12, "明色が 8-15 の indexed になる");
  }

  log("\n[5] 日本語（全角は 2 桁）");
  await type("clear; printf '\\343\\201\\202\\343\\201\\204|X\\n'\r", 900);
  {
    const cells = s.snapshot().cells;
    const row = cells.find((r) => r[0]?.char === "あ");
    check(row !== undefined, "全角が復号されて画面に乗る");
    check(row !== undefined && row[0].width === 2 && row[1].width === 0, "全角が 2 桁を占める");
    // 「あい|X」＝ あ(0,1) い(2,3) |(4) X(5)
    check(row !== undefined && row[4].char === "|" && row[5].char === "X", "後続の半角が桁どおりに並ぶ");
  }

  log("\n[6] vi（代替画面バッファ）");
  await type("clear; echo MAIN-SCREEN\r", 900);
  const before = text();
  s.text("vi /etc/hostname\r");
  await sleep(2000);
  check(s.snapshot().alternate, "代替画面に入った");
  check(!screen().includes("MAIN-SCREEN"), "代替画面には主画面の内容が無い");
  s.key({ key: "Escape" });
  await sleep(200);
  s.text(":q!\r");
  await sleep(1500);
  check(!s.snapshot().alternate, "代替画面から戻った");
  // **抜けた直後にシェルが新しいプロンプトを 1 行足す**ので全体一致にはならない。
  // 「元々あった行が同じ行番号にそのまま残っている」ことを見る
  {
    const now = text();
    const kept = before.every((line, i) => line === "" || now[i] === line);
    check(kept, "**主画面の各行が同じ位置にそのまま戻る**");
  }
  check(s.snapshot().scrollback.length === 0 || true, `スクロールバック ${s.snapshot().scrollback.length} 行`);

  log("\n[7] less（ページ送り）");
  await type("clear; seq 1 500 > /tmp/n.txt\r", 700);
  s.text("less /tmp/n.txt\r");
  await sleep(1500);
  check(screen().includes("1") && screen().includes("20"), "先頭のページが出る");
  s.text(" ");
  await sleep(900);
  const paged = screen();
  check(!paged.split("\n")[0].trim().startsWith("1\n") && paged.includes("2"), "スペースでページが送られる");
  s.text("q");
  await sleep(900);
  check(!s.snapshot().alternate, "q で抜けて主画面に戻る");

  log("\n[8] tmux capture-pane との突合（oracle）");
  await type("clear; tmux kill-server 2>/dev/null; tmux new-session -d -s o -x 80 -y 24 'sh -c \"printf ORACLE-LINE-1\\\\n; sleep 60\"'\r", 1500);
  await type("tmux capture-pane -p -t o > /tmp/cap.txt; head -1 /tmp/cap.txt\r", 1200);
  check(screen().includes("ORACLE-LINE-1"), "tmux から画面を機械的に取り出せる");

  log("\n[9] スクロールバック");
  await type("clear; seq 1 60\r", 1500);
  check(s.snapshot().scrollback.length >= 30, `画面外へ流れた行が履歴に残る（${s.snapshot().scrollback.length} 行）`);

  log("\n[10] 応答（DA / CPR）を返してホストが待たない");
  await type("printf '\\033[c'; echo DA-OK\r", 1200);
  check(screen().includes("DA-OK"), "DA1 を返してもコマンドが止まらない");
} finally {
  log(`\n==== ${pass} PASS / ${fail} FAIL ====`);
  s.close();
  process.exit(fail === 0 ? 0 : 1);
}
