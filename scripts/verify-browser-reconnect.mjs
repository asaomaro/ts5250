// **接続の寿命（瞬断・はしご・手動の再接続・半開き）と、打鍵→描画の時間を、実機・実ブラウザで測る。**
//
// 単体テスト（`session-reconnect.test.ts` ほか）は、WebSocket を模して状態遷移を見る。
// 実際の TCP の切れ方（RST・接続拒否・黙って止まる）と、実機のホストセッションが猶予の間に生き残るかは、
// 実物を動かさないと分からない。ここでは、ブラウザとサーバーの間に **TCP 中継**を挟んで瞬断を作る
// （`20260919-backlog-acs-triage` research F0-4・F2）。
//
//   中継の状態: pass（通す）/ refuse（新しい接続を受けてすぐ RST で落とす。ECONNREFUSED ではない）/
//               blackhole（黙って止める＝半開き。片側が閉じても反対側へ伝えない）
//   cut():      ブラウザ側の口を RST で落とす（サーバー側の口は閉じるだけ＝FIN）
//
// シナリオ（引数で選ぶ。既定は S1 S2 S3 S4 LAT）:
//   S1  ユーザー・タスクの画面で 3 秒の断 → 同じ画面に戻り、F3 がホストに通る（同じジョブ）
//   S2  応答待ち（DLYJOB 6 秒）の最中に 3 秒の断 → 最新の画面に戻り、応答待ちが解ける
//   S3  40 秒の断（はしご 1+2+4+8+16 秒を使い切る）→「再接続」ボタンが出る → 押すと戻る
//   S4  最初の ping を受けてから半開き → PING_DEAD_MS＋保険（約 93 秒）で再接続中になり、戻る
//   S4a ping を受ける前に半開き → 130 秒以内に再接続中になる。
//       **現状は FAIL が正しい結果**（見張りが最初の ping まで張られない。
//       `.aidev/backlog/session-lifecycle.md`「ping の見張りが…」）。直ったら既定に入れる
//   LAT 打鍵 → screen 受信 → 描画・覆いの解除の時間（`1` と F3 の 15 往復＝打鍵 30 回）。判定はせず、基準線として出す
//   （research の F2 は S4 を「S4b」と呼んでいる。同じもの）
//
// **時間はページ内の時計で測る**（`performance.now()`）。Playwright の framesent / framereceived は
// CDP 経由で約 200ms 遅れて届くので使わない。**負荷の高いとき（並行してテストを回している等）の
// 計測も信用しない**——`20260919-backlog-acs-triage` で p50 465ms と出た値は負荷によるもので、落ち着いてから 72〜137ms だった。
//
// 実行: node --env-file=.env --env-file=.env.verify scripts/verify-browser-reconnect.mjs [S1 S2 S3 S4 S4a LAT]
//   （事前に `npm run build` と `npm run build -w @ts5250/web-ui` が要る）
// 副作用: 実機へ表示セッションを 1 本張る（装置名はホストに採らせる）。メニューの移動と
// `DLYJOB` だけで、オブジェクトは作らない。最後に SIGNOFF する。所要は既定で約 4 分（S4 が 2 分弱）。
// サーバーも中継も **127.0.0.1 だけ**で待ち受ける——認証オフ・自動サインオンの設定で立てるので、
// 外から開けると誰でもその利用者としてサインオンできてしまう（AGENTS.md「認証オフの HTTP は既定で 127.0.0.1 のみ」）。
// 出力は他の検証スクリプトと同じ PASS / FAIL。CCSID は日本語機の既定の 930、システム id は検証用の仮の名前。
import net from "node:net";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serve } from "@hono/node-server";
import { WebSocketServer } from "ws";
import { buildApp, SessionManager, ServerConfigStore, PersonalConfigStore, ConfigResolver } from "@ts5250/server";
import { SecretCrypto } from "../packages/server/dist/secret-crypto.js";
import { chromium } from "playwright";

const host = process.env.AS400_HOST;
const user = process.env.AS400_USER;
if (!host || !user || !process.env.AS400_PASSWORD) {
  process.stderr.write("AS400_HOST / AS400_USER / AS400_PASSWORD を環境変数で渡してください\n");
  process.exit(2);
}
const KNOWN = ["S1", "S2", "S3", "S4", "S4a", "LAT"];
const args = process.argv.slice(2);
// **知らないシナリオ名は止める**——黙って無視すると、打ち間違えたときに何も走らず「合格」になる
const unknown = args.filter((a) => !KNOWN.includes(a));
if (unknown.length) {
  process.stderr.write(`知らないシナリオ: ${unknown.join(" ")}（使えるのは ${KNOWN.join(" ")}）\n`);
  process.exit(2);
}
const WANT = new Set(args.length ? args : ["S1", "S2", "S3", "S4", "LAT"]);
const SERVER_PORT = Number(process.env.PORT ?? 3571);
const RELAY_PORT = SERVER_PORT + 1;
const T0 = Date.now();
const log = (s) => process.stdout.write(`[${((Date.now() - T0) / 1000).toFixed(1)}s] ${s}\n`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0;
let fail = 0;
const check = (cond, msg) => {
  if (cond) { pass++; log(`  PASS ${msg}`); } else { fail++; log(`  FAIL ${msg}`); }
};

// ---- サーバー（in-process。`verify-acs-display.mjs` と同じ形）----
const work = mkdtempSync(join(tmpdir(), "reconnect-"));
// 一時の設定（接続先と利用者名が入る）は、途中で落ちても消す
process.on("exit", () => rmSync(work, { recursive: true, force: true }));
const cfgPath = join(work, "profiles.json");
// **パスワードはファイルに書かない**——`passwordEnv` で環境変数を指す。装置名も書かない（ホストに採らせる）
writeFileSync(
  cfgPath,
  JSON.stringify({
    systems: [{ id: "REAL", name: "REAL", host, ccsid: 930, signon: { user, passwordEnv: "AS400_PASSWORD" } }],
    sessions: [{ id: "DSP", name: "DSP", system: "REAL", sessionType: "display", screenSize: "24x80" }]
  })
);
const crypto = SecretCrypto.fromEnv();
const resolver = new ConfigResolver(
  ServerConfigStore.fromFile(cfgPath, crypto),
  new PersonalConfigStore({ systems: [], sessions: [] }, crypto)
);
const sessions = new SessionManager();
const app = buildApp({ sessions, resolver, version: "verify", webRoot: "packages/web-ui/dist" });
const wss = new WebSocketServer({ noServer: true });
const server = serve({ fetch: app.fetch, port: SERVER_PORT, hostname: "127.0.0.1", websocket: { server: wss } });
const portBusy = (what) => (e) => {
  process.stderr.write(`${what}（${e.code ?? e.message}）。PORT で別の番号を指定してください\n`);
  process.exit(2);
};
server.on("error", portBusy(`サーバーのポート ${SERVER_PORT} を開けません`));

// ---- 中継（瞬断を作る）----
let mode = "pass";
const pairs = new Set();
net
  .createServer((c) => {
    if (mode === "refuse") {
      c.resetAndDestroy();
      return;
    }
    const u = net.connect(SERVER_PORT, "127.0.0.1");
    const p = { c, u };
    pairs.add(p);
    // blackhole の間はどちら向きも捨てる（TCP は生きたまま＝半開き）
    c.on("data", (d) => { if (mode !== "blackhole") u.write(d); });
    u.on("data", (d) => { if (mode !== "blackhole") c.write(d); });
    // **blackhole の間は、片側が閉じても反対側へ伝えない。** 伝えると、サーバーの心拍が相手を死んだと
    // 判定して閉じた（約 120 秒）ことがブラウザに届き、本物の半開き（回線が死んで何も届かない）では
    // 起きない「検出」をしてしまう（`20260919-backlog-acs-triage` の S4a で踏んだ）
    const close = (other) => () => {
      if (mode !== "blackhole") other.destroy();
      if (c.destroyed && u.destroyed) pairs.delete(p);
    };
    c.on("error", () => undefined); u.on("error", () => undefined);
    c.on("close", close(u)); u.on("close", close(c));
  })
  .on("error", portBusy(`中継のポート ${RELAY_PORT} を開けません`))
  .listen(RELAY_PORT, "127.0.0.1");
/** ブラウザ側の口を RST で落とす（ブラウザには close 1006 が届く）。サーバー側の口は閉じるだけ */
const cut = () => {
  for (const p of pairs) { p.c.resetAndDestroy(); p.u.destroy(); }
  pairs.clear();
};
await sleep(600);

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
page.on("pageerror", (e) => log("PAGEERR " + e.message));
// ページ内の時計で WebSocket の送受信と画面の変化に印を打つ
await page.addInitScript(() => {
  window.__t = [];
  const W = window.WebSocket;
  window.WebSocket = class extends W {
    constructor(...a) {
      super(...a);
      // ソケットごとに区切る——「このソケットで ping を受けたか」を、前のソケットの記録と混ぜないため
      this.addEventListener("open", () => window.__t.push([performance.now(), "ws-open"]));
      this.addEventListener("message", (e) => {
        try {
          const m = JSON.parse(e.data);
          if (m.type === "screen" || m.type === "ping") window.__t.push([performance.now(), "<" + m.type]);
        } catch { /* 文字列以外は対象外 */ }
      });
    }
    send(d) {
      try { if (JSON.parse(d).type === "key") window.__t.push([performance.now(), ">key"]); } catch { /* 同上 */ }
      return super.send(d);
    }
  };
  // 覆いの出入りだけを記録する（画面の文字まで読むと、LAT が測る経路に負荷を足す）
  const mo = new MutationObserver(() => {
    const b = !!document.querySelector(".busy-overlay") || !!document.querySelector(".oia .lock");
    if (b !== window.__busy) { window.__busy = b; window.__t.push([performance.now(), b ? "busy+" : "busy-"]); }
  });
  document.addEventListener("DOMContentLoaded", () =>
    mo.observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true })
  );
});

const grid = () => page.evaluate(() => document.querySelector(".grid")?.textContent ?? "");
const oia = () => page.evaluate(() => (document.querySelector(".oia")?.textContent ?? "").replace(/\s+/g, " "));
const busy = () => page.evaluate(() => !!document.querySelector(".busy-overlay") || !!document.querySelector(".oia .lock"));
const inputs = () => page.locator("input.grid-input:not([readonly])");
/** 入力欄が無い画面（サインオン情報など）では画面そのものを押してフォーカスを取る */
async function focusInput() {
  const el = inputs().last();
  if (await el.count()) await el.click();
  else await page.locator(".grid").first().click();
}
async function cmd(text) {
  await focusInput();
  await page.keyboard.press("Home");
  await page.keyboard.type(text, { delay: 10 });
  await page.keyboard.press("Enter");
}
/** 条件が真になるまでの ms。時間切れは -1 */
async function until(fn, timeout, step = 100) {
  const t = Date.now();
  while (Date.now() - t < timeout) {
    if (await fn()) return Date.now() - t;
    await sleep(step);
  }
  return -1;
}
// メニューは 1 行目（`.grid-row` の先頭）のメニュー ID で見分ける。本文の「1. ユーザー・タスク」を画面名と
// 取り違えないため。`.grid` 全体の文字は、桁の目盛りや操作員メッセージが先頭に来るので使わない
const firstRow = () => page.evaluate(() => document.querySelector(".grid .grid-row")?.textContent ?? "");
const menuId = async () => (/^\s*(MAIN|USER)\b/.exec(await firstRow()) ?? [])[1];
/** コマンド行（最後の入力欄）の値。打鍵は `<input>` の value にあり、`.grid` の文字には含まれない */
const cmdValue = async () => ((await inputs().count()) ? await inputs().last().inputValue() : "");
/** これまでに開いたソケットの数（繋ぎ直しで新しいソケットが開いたかを見る） */
const socketsOpened = () => page.evaluate(() => window.__t.filter((x) => x[1] === "ws-open").length);
/** このソケット（最後に開いたもの）で ping を受けたか */
const pingOnCurrentSocket = () =>
  page.evaluate(() => {
    const t = window.__t;
    let i = t.length - 1;
    while (i >= 0 && t[i][1] !== "ws-open") i--;
    return t.slice(i + 1).some((x) => x[1] === "<ping");
  });
const onMain = async () => (await menuId()) === "MAIN";
const onUser = async () => (await menuId()) === "USER";
const reconnecting = async () => /再接続中|切断/.test(await oia());
/** 繋がっていて、覆いが無く、期待の画面が出ている */
const recovered = (expect) => async () => !(await reconnecting()) && !(await busy()) && (await expect());

try {
  // ---- 接続・サインオン ----
  await page.goto(`http://127.0.0.1:${RELAY_PORT}/`);
  await page.waitForSelector(".launcher", { timeout: 15_000 });
  const pick = page.locator(".card", { hasText: "REAL" }).first().locator("button", { hasText: "選択" });
  if (await pick.count()) { await pick.click(); await sleep(400); }
  await page.locator(".card", { hasText: "DSP" }).first().locator("button", { hasText: /^(接続|開く)$/ }).click();
  await until(async () => (await grid()).length > 300, 40_000);
  for (let i = 0; i < 10 && !(await onMain()); i++) {
    const g = await grid();
    // **サインオン画面は「利用者名とパスワードの入力欄がある」で見分ける**——「パスワード」の語だけだと
    // サインオン情報の画面（F9=パスワードの変更）を取り違える（`20260919-backlog-acs-triage` で踏んだ）
    if (/ユーザー/.test(g) && /パスワード/.test(g) && (await inputs().count()) >= 2) {
      await inputs().nth(0).click(); await page.keyboard.press("Home"); await page.keyboard.type(user, { delay: 15 });
      await inputs().nth(1).click(); await page.keyboard.press("Home");
      await page.keyboard.type(process.env.AS400_PASSWORD, { delay: 15 });
      await page.keyboard.press("Enter");
    } else if (/対話式ジョブの回復/.test(g)) await cmd("90");
    else { await focusInput(); await page.keyboard.press("Enter"); }
    await sleep(1800);
  }
  check(await onMain(), "メインメニューに着いた");

  if (WANT.has("S1")) {
    log("=== S1: ユーザー・タスクの画面で 3 秒の断（RST＋拒否）");
    await cmd("1");
    await until(onUser, 15_000);
    mode = "refuse"; cut();
    await sleep(3000); mode = "pass";
    const t = await until(recovered(onUser), 30_000);
    check(t >= 0, `同じ画面に戻った（戻してから ${t}ms）`);
    await focusInput(); await page.keyboard.press("F3");
    const t2 = await until(onMain, 15_000);
    check(t2 >= 0, `F3 がホストに通った（${t2}ms。同じジョブが続いている）`);
  }

  if (WANT.has("S2")) {
    log("=== S2: 応答待ち（DLYJOB 6 秒）の最中に 3 秒の断");
    const tSent = Date.now();
    await cmd("DLYJOB DLY(6)");
    await sleep(500);
    mode = "refuse"; cut();
    await sleep(3000); mode = "pass";
    // DLYJOB が終わった後の画面＝メインメニューで、コマンド行が空。DLYJOB の前の画面（打った文字が残る）に
    // 戻っても合格にしないよう、コマンド行の値と経過時間（6 秒以上）の両方で見る
    const t = await until(
      recovered(async () => (await onMain()) && !/DLYJOB/.test(await cmdValue()) && Date.now() - tSent >= 6000),
      30_000
    );
    check(t >= 0, `DLYJOB が終わった後の画面に戻り、応答待ちが解けた（戻してから ${t}ms）`);
    await cmd("1");
    const t2 = await until(onUser, 15_000);
    check(t2 >= 0, `続けて操作できた（${t2}ms）`);
    await focusInput(); await page.keyboard.press("F3"); await until(onMain, 15_000);
  }

  if (WANT.has("S3")) {
    log("=== S3: 40 秒の断（はしごを使い切る）→ 手動の再接続");
    mode = "refuse"; cut();
    const retry = page.locator(".oia .fk.retry").first();
    const tGave = await until(async () => (await retry.count()) > 0, 60_000, 200);
    check(tGave >= 0, `「再接続」ボタンが出た（断から ${tGave}ms）`);
    await sleep(Math.max(0, 40_000 - Math.max(tGave, 0)));
    mode = "pass";
    if (await retry.count()) await retry.click();
    const t = await until(recovered(onMain), 30_000);
    check(t >= 0, `押すと元の画面に戻った（${t}ms。サーバーの猶予 90 秒以内）`);
  }

  if (WANT.has("S4")) {
    log("=== S4: 最初の ping を受けてから半開き");
    const tp = await until(pingOnCurrentSocket, 45_000, 500);
    check(tp >= 0, `このソケットで ping を受けた（${tp}ms 待った）`);
    mode = "blackhole";
    const tDet = await until(reconnecting, 110_000, 500);
    check(tDet >= 0 && tDet <= 100_000, `約 93 秒で再接続中になった（${tDet}ms）`);
    cut(); mode = "pass";
    const t = await until(recovered(onMain), 30_000);
    check(t >= 0, `戻った（${t}ms）`);
  }

  if (WANT.has("S4a")) {
    log("=== S4a: ping を受ける前に半開き（N19 の再現。直るまで FAIL が正しい）");
    // 新しいソケットを作らせ、最初の ping（30 秒周期）が届く前に止める
    const opened = await socketsOpened();
    cut();
    // **新しいソケットが開くのを先に待つ**——`cut()` の直後は、ページが切断を反映する前で `recovered` が
    // 真になりうる。そのまま進むと前提の確認が古いソケットを見て、N19 が直ったような偽の合格が出る
    const tr = await until(async () => (await socketsOpened()) > opened && (await recovered(onMain)()), 30_000);
    check(tr >= 0, `新しいソケットで繋ぎ直した（${tr}ms）`);
    // 前提: まだ ping を受けていないこと。受けていたら見張りが張られていて、S4a の意味が無い
    check(!(await pingOnCurrentSocket()), "半開きにする時点で、このソケットはまだ ping を受けていない");
    mode = "blackhole";
    const tDet = await until(reconnecting, 130_000, 500);
    check(tDet >= 0, `ping を受ける前の半開きも検出した（${tDet}ms）`);
    cut(); mode = "pass";
    await until(recovered(onMain), 30_000);
  }

  if (WANT.has("LAT")) {
    log("=== LAT: 打鍵 → 描画（メニューの 1 と F3 を 15 往復）");
    await page.evaluate(() => { window.__t = []; });
    for (let i = 0; i < 15; i++) {
      await cmd("1"); await until(onUser, 20_000, 20); await until(async () => !(await busy()), 20_000, 20);
      await focusInput(); await page.keyboard.press("F3"); await until(onMain, 20_000, 20);
      await until(async () => !(await busy()), 20_000, 20);
    }
    const T = await page.evaluate(() => window.__t);
    const toScreen = [];
    const toRender = [];
    let k = -1;
    let sawScreen = false;
    for (const [t, ev] of T) {
      if (ev === ">key") { k = t; sawScreen = false; continue; }
      if (k < 0) continue;
      if (ev === "<screen" && !sawScreen) { toScreen.push(t - k); sawScreen = true; }
      if (ev === "busy-") { toRender.push(t - k); k = -1; }
    }
    const q = (xs, r) => { const s = [...xs].sort((a, b) => a - b); return Math.round(s[Math.min(s.length - 1, Math.floor(s.length * r))] ?? NaN); };
    log(`  打鍵→screen: n=${toScreen.length} p50=${q(toScreen, 0.5)}ms p90=${q(toScreen, 0.9)}ms`);
    log(`  打鍵→描画・覆いの解除: n=${toRender.length} p50=${q(toRender, 0.5)}ms p90=${q(toRender, 0.9)}ms max=${q(toRender, 1)}ms`);
  }
} finally {
  try { mode = "pass"; await cmd("SIGNOFF"); await sleep(2000); } catch { /* 片付けの失敗は結果に含めない */ }
  await browser.close();
}
log(`\n${pass} PASS / ${fail} FAIL`);
process.exit(fail === 0 ? 0 : 1);
