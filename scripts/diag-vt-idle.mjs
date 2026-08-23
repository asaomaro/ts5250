// **VT セッションがアイドルを越えられるか**を実機で測る（backlog `hostserver.md`）。
//
// プリンター（5250）で分かったこと: `tn5250` / `vt` / `tn3270` の TCP に
// **キープアライブが無く**、15 分のアイドルで接続が黙って死んでいた。
// **VT も同じ形の `TcpTransport` を通る**ので、同じことが起きていたはず。
//
// ⚠ **相手は pub400 に限る。** SR-OSAKA は VT の交渉まで進むが画面が 1 バイトも来ない
// （サブシステムが仮想装置をオフにする。`verify-vt-ibmi.mjs` の注記）。
// pub400 は `QINACTITV = 120`（分）なので、30 分のアイドルでもホスト方針に掛からない。
//
// ⚠ **VT は文字モード**。生死は「送った文字がホストから返ってくるか」で見る
// （ホストが ECHO を握っているので、送った文字は画面に現れる）。
//
// 実行:
//   IDLE_MIN=30 node --env-file=.env scripts/diag-vt-idle.mjs            # サインオン画面のまま
//   SIGNON=1 IDLE_MIN=30 node --env-file=.env scripts/diag-vt-idle.mjs   # サインオンしてから
//
// ⚠ **この 2 つは別のことを測る。** サインオン画面のまま放置した接続は、
// ホストが「使われていない装置」として片づけているかもしれない
// ——それは transport の話ではない。**両方測らないと切り分けられない**。
//
// 副作用: `SIGNON=1` のときだけ対話ジョブを作る（最後にサインオフする）。
// ⚠ **サインオンの失敗は QMAXSIGN に数えられる**（pub400=5）ので 1 回だけ試す。
import { appendFileSync } from "node:fs";
import { VtSession } from "@ts5250/vt";

const host = process.env.PUB400_HOST;
if (!host) {
  process.stderr.write("PUB400_HOST が要ります\n");
  process.exit(2);
}
const IDLE_MIN = Number(process.env.IDLE_MIN ?? 30);
const OUT = process.env.LOGFILE;
const log = (s) => {
  const line = `[${new Date().toISOString().slice(11, 19)}] ${s}`;
  process.stdout.write(line + "\n");
  if (OUT) appendFileSync(OUT, line + "\n");
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const s = await VtSession.connect({
  host,
  port: 23,
  rows: 24,
  cols: 80,
  // **IBM i には VT220**。xterm 系の名前は知らないので SEND を繰り返される
  terminalTypes: ["VT220"],
  ccsid: 37
});
const screen = () =>
  s
    .snapshot()
    .cells.map((r) => r.map((c) => (c.width === 0 ? "" : c.char)).join("").replace(/ +$/u, ""))
    .join("\n");

let closed;
s.on("close", (r) => {
  closed = r ?? "（理由なし）";
  log(`  **close が届いた**: ${closed}`);
});

/** 1 文字送って画面が変わるかを見る。**変われば往復が生きている** */
async function echoes(waitMs = 20_000) {
  const before = screen();
  s.text("x");
  const t0 = Date.now();
  while (Date.now() - t0 < waitMs) {
    await sleep(500);
    if (screen() !== before) return { ok: true, ms: Date.now() - t0 };
  }
  return { ok: false, ms: Date.now() - t0 };
}

try {
  await sleep(4000);
  if (screen().trim() === "") throw new Error("画面が 1 バイトも来ていない（VT を出せない相手）");
  log(`接続できた: ホスト ECHO=${s.hostEchoes} 端末=${s.terminalType}`);

  // ---- サインオン（指定時のみ） ----
  if (process.env.SIGNON === "1") {
    const user = process.env.PUB400_USER;
    const password = process.env.PUB400_PASSWORD;
    if (!user || !password) throw new Error("SIGNON=1 には PUB400_USER / _PASSWORD が要る");
    s.text(user);
    await sleep(600);
    s.key({ key: "Tab" });
    await sleep(900);
    s.text(password);
    await sleep(600);
    s.key({ key: "Enter" });
    await sleep(8000);
    if (/Press Enter|継続するには/iu.test(screen())) {
      s.key({ key: "Enter" });
      await sleep(4000);
    }
    const after = screen();
    if (!/Main Menu|メインメニュー|MAIN/u.test(after)) {
      throw new Error(`サインオンできていない: ${after.split("\n").find((l) => l.trim()) ?? "(空)"}`);
    }
    log("  サインオンした（対話ジョブあり）");
  }

  // ---- 対照 ----
  const c = await echoes();
  log(`対照: 送った文字が返る=${c.ok} / ${c.ms}ms`);
  if (!c.ok) throw new Error("アイドル前から返らない（前提が崩れている）");
  // 打った文字を消しておく（欄を汚さない）
  s.text("\b");

  // ---- アイドル ----
  log(`\n### ${IDLE_MIN} 分のアイドル（**何も送らない**）`);
  await sleep(IDLE_MIN * 60_000);

  // ---- 明け ----
  log(`\n### アイドル明け`);
  log(`  close は届いているか: ${closed ?? "**届いていない**"}`);
  const a = await echoes(60_000);
  log(`  送った文字が返る=${a.ok} / ${a.ms}ms`);

  log("\n### 判定");
  if (a.ok) log(`  **越えられた**——${IDLE_MIN} 分のアイドル後も往復する`);
  else if (closed) log(`  **切れていた（理由あり）**: ${closed}`);
  else log("  **黙って死んでいた**——close も来ず、送っても返らない");
} catch (e) {
  log(`例外: ${e?.message ?? e}`);
} finally {
  if (process.env.SIGNON === "1") {
    // **ジョブを残さない**（対話ジョブを作った場合だけ）
    try {
      s.text("SIGNOFF");
      s.key({ key: "Enter" });
      await sleep(3000);
    } catch { /* 良い */ }
  }
  try { s.close(); } catch { /* 良い */ }
}
