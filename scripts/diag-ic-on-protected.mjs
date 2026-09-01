// **ホストがカーソルを入力できない位置に置いたとき、そこは「保護欄の中」か「欄の外」か**を測る。
//
// 2 つの実例を同じものさしで並べる:
//   ① CURSORTS3（上をプロテクトして下を展開・カーソルは上に残る）… 利用者報告の画面
//   ② SEU の走査検索（表示モード）… 見つかった桁にカーソルを置いてほしい画面（過去の指摘）
//
// ①だけを「先頭の入力欄へ寄せる」ようにできるなら、②を壊さずに ACS へ揃えられる。
// 読むだけ。実行: node --env-file=.env --env-file=.env.verify scripts/diag-ic-on-protected.mjs
import { Session5250 } from "@ts5250/tn5250";

const host = process.env.AS400_HOST, user = process.env.AS400_USER, password = process.env.AS400_PASSWORD;
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

/** カーソルの立っている桁が「どこ」なのかを、欄の情報として出す */
function where(label) {
  const s = session.snapshot();
  const cur = s.cursor;
  const cell = s.cells[cur.row - 1]?.[cur.col - 1];
  // その桁を含む欄を探す（行またぎは考えない。この検証の画面には無い）
  const f = s.fields.find((x) => x.row === cur.row && cur.col >= x.col && cur.col < x.col + x.length);
  const inputs = s.fields.filter((x) => !x.protected);
  log(`\n===== ${label} =====`);
  text(s).split("\n").forEach((l, i) => { if (l.trim()) log(String(i + 1).padStart(2) + "|" + l.slice(0, 78)); });
  log(`  カーソル: ${cur.row}/${cur.col}  桁の中身: ${JSON.stringify(cell?.char ?? "")}`);
  log(`  その桁の欄: ${f ? `#${f.index} r${f.row}c${f.col}(${f.length}) ${f.protected ? "**保護欄の中**" : "入力欄の中"}` : "**どの欄にも属さない（欄の外）**"}`);
  log(`  画面の入力欄: ${inputs.length} 個 ` + inputs.slice(0, 6).map((x) => `r${x.row}c${x.col}`).join(" "));
  return { cur, f, inputs };
}

// --- サインオン ---
let snap = session.snapshot();
for (let i = 0; i < 10; i++) {
  const t = text(snap);
  if (t.includes("コマンドを入力") || t.includes("Selection or command")) break;
  const inputs = snap.fields.filter((f) => !f.protected);
  if (t.includes("サイン・オン") || t.includes("Sign On")) {
    if (inputs[0]) session.setField({ index: inputs[0].index }, user);
    if (inputs[1]) session.setField({ index: inputs[1].index }, password);
  } else if (t.includes("回復")) { if (inputs[0]) session.setField({ index: inputs[0].index }, "90"); }
  await session.sendAid("Enter", { timeoutMs: 15000 });
  await sleep(700);
  snap = session.snapshot();
}
const cmdField = () => session.snapshot().fields.filter((f) => !f.protected).find((f) => f.length > 20);

// --- ① 展開画面（利用者報告） ---
{
  const c = cmdField();
  session.setField({ index: c.index }, `CALL ${LIB}/CURSORCL3`);
  await session.sendAid("Enter", { timeoutMs: 25000 });
  await sleep(1500);
  const top = session.snapshot().fields.filter((f) => !f.protected)[0];
  if (top) session.setField({ index: top.index }, "ABC123");
  await session.sendAid("Enter", { timeoutMs: 25000 });
  await sleep(1800);
  where("① 展開画面の 2 画面目（ACS は下の入力欄へ寄せる）");
  await session.sendAid("F3", { timeoutMs: 15000 }).catch(() => {});
  await sleep(1200);
}

// --- ② SEU の走査検索（表示モード） ---
{
  const c = cmdField();
  if (c) {
    session.setField({ index: c.index }, `STRSEU SRCFILE(${LIB}/QDDSSRC) SRCMBR(CURSORTST) OPTION(5)`);
    await session.sendAid("Enter", { timeoutMs: 30000 });
    await sleep(2500);
    where("② SEU 表示モード（検索前）");
    // SEU==> 行に走査を打つ
    const seu = session.snapshot().fields.filter((f) => !f.protected)[0];
    if (seu) {
      session.setField({ index: seu.index }, "F 'DSPATR'");
      await session.sendAid("Enter", { timeoutMs: 25000 });
      await sleep(2000);
      where("② SEU 表示モードで走査が当たった直後（見つかった桁にカーソル）");
    }
    await session.sendAid("F3", { timeoutMs: 20000 }).catch(() => {});
    await sleep(1500);
    await session.sendAid("F12", { timeoutMs: 15000 }).catch(() => {});
    await sleep(800);
  }
}
session.close?.();
process.exit(0);
