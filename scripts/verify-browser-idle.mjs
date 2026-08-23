// 実ブラウザ（web-ui）で実機へ接続し、**セッションの寿命**が端から端まで効くか検証する。
//
//   既定（永続）    — 無操作のまま放置しても切れない。**110 秒放置する**ので、
//                     同時に**ハートビートの往復**も検証している（pong を返さなければ
//                     サーバーは 90 秒で半開きと判断して畳む）
//   有限値 × 放置   — セッション設定の `idleTimeout: 1`（1 分）で、無操作なら切れる
//   有限値 × 操作中 — 打鍵していれば切れない（**AID キーは押さない**）。
//                     これが在席の合図（`{type:"activity"}`）の唯一の実地検証
//
// **打鍵中に切られないことは、ここでしか分からない。** 単体テストは合図を出すところと
// `lastActivity` が進むところまでしか見ておらず、間引き（15 秒）と掃除の間隔と
// タイムアウト値の噛み合わせは実物を動かすほかない。
//
// 掃除の間隔だけ 2 秒に縮めている（`startIdleSweep(2000)`）。**判定そのものは実装のまま**で、
// 「超過を見つけてから切るまで」の待ち時間を削っているだけ。
//
// 前提: npm run build 済み。`connections.json` に実機と DEV1。
// 実行: AS400_PASSWORD=... node scripts/verify-browser-idle.mjs
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { serve } from "@hono/node-server";
import { WebSocketServer } from "ws";
import { buildApp, SessionManager, ServerConfigStore, PersonalConfigStore, ConfigResolver } from "@ts5250/server";
import { SecretCrypto } from "../packages/server/dist/secret-crypto.js";
import { chromium } from "playwright";

const log = (s) => process.stderr.write(s + "\n");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const PORT = 3483;
const TMP = process.env.IDLE_TMP ?? "/tmp/as400-verify-idle";
const SHOTS = process.env.IDLE_SHOTS ?? `${TMP}/shots`;
mkdirSync(SHOTS, { recursive: true });

const results = [];
const check = (n, ok, d = "") => {
  results.push({ n, ok });
  process.stdout.write(`${ok ? "OK  " : "NG  "} ${n}${d ? ` — ${d}` : ""}\n`);
};

const cfg = JSON.parse(readFileSync("connections.json", "utf8"));
const sys = cfg.systems.find((s) => s.name === (process.env.AS400_SYSTEM ?? "AS400"));
const baseSess = cfg.sessions.find((s) => s.name === (process.env.AS400_SESSION ?? "DEV1"));
// **1 分で切れるセッション設定を足す。** 装置名は DEV1 と同じ（同時には使わない）
cfg.sessions.push({ ...baseSess, id: `${baseSess.id}-t1`, name: "DEV1-1MIN", idleTimeout: 1 });
const tmpCfg = `${TMP}/conn-idle.json`;
mkdirSync(TMP, { recursive: true });
writeFileSync(tmpCfg, JSON.stringify(cfg));

const crypto = SecretCrypto.fromEnv();
// **パスワードはスクリプトに書かない。** 環境変数で受ける（AGENTS.md セキュリティ）
const password = process.env.AS400_PASSWORD;
const user = sys.signon.user;
if (!password) {
  log("AS400_PASSWORD が未設定です");
  process.exit(1);
}

const sessions = new SessionManager(); // 既定＝永続（この変更の主題）
// 掃除の間隔だけ縮める。判定は実装のまま
sessions.startIdleSweep(2000);
const resolver = new ConfigResolver(
  ServerConfigStore.fromFile(tmpCfg, crypto),
  new PersonalConfigStore({ systems: [], sessions: [] }, crypto)
);
const app = buildApp({ sessions, resolver, version: "verify", webRoot: "packages/web-ui/dist" });
const wss = new WebSocketServer({ noServer: true });
const server = serve({ fetch: app.fetch, port: PORT, websocket: { server: wss } });
await sleep(600);

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1500, height: 900 } });
page.on("pageerror", (e) => log("PAGEERR " + e.message));

const bodyText = () => page.locator("body").innerText();
const has = async (t) => (await bodyText()).includes(t);
const inputs = () => page.locator("input.grid-input:not([readonly])");
const shot = async (name) => {
  const p = `${SHOTS}/${name}.png`;
  await page.screenshot({ path: p });
  log(`shot: ${p}`);
  return p;
};
const clickEnter = async () => {
  const b = page.getByText("⏎ 実行", { exact: false }).first();
  if (await b.count()) await b.click();
  else await page.keyboard.press("Enter");
};
async function runCmd(text) {
  const el = inputs().last();
  await el.click();
  await page.keyboard.press("Home");
  await page.keyboard.type(text, { delay: 15 });
  await clickEnter();
  await sleep(1500);
}

/** 接続 → サインオン → メインメニューまで運ぶ */
async function connect(cardName) {
  await page.goto(`http://localhost:${PORT}/`);
  await page.waitForSelector(".launcher", { timeout: 20000 });
  await page.click(".card:has-text('実機') >> button:has-text('選択')");
  await page.waitForSelector(`.card:has-text('${cardName}')`, { timeout: 10000 });
  await page.click(`.card:has-text('${cardName}') >> button:has-text('接続')`);
  await page.waitForFunction(
    () => /サインオン|ユーザー|回復|メインメニュー/.test(document.body.innerText),
    { timeout: 25000 }
  );
  await sleep(900);
  // **サインオンの入力はループの中で行う。** 1 回だけ先に試すと、前回の実行が装置を掴んでいて
  // 最初の画面が「対話式ジョブの回復」だった場合に取りこぼし、以後は空のサインオンを
  // Enter で送り続けて `CPF1296 サインオン情報が必要である` で詰まる（実際に踏んだ）
  for (let i = 0; i < 20; i++) {
    if (await has("メインメニュー")) break;
    if (await has("対話式ジョブの回復")) {
      const el = inputs().last();
      await el.click();
      await page.keyboard.press("Home");
      await page.keyboard.type("90", { delay: 30 });
      await clickEnter();
    } else if ((await has("サイン")) && (await has("ユーザー"))) {
      const u = inputs().nth(0);
      await u.click();
      await page.keyboard.press("Home");
      await page.keyboard.type(user, { delay: 20 });
      const p = inputs().nth(1);
      await p.click();
      await page.keyboard.press("Home");
      await page.keyboard.type(password, { delay: 20 });
      await clickEnter();
    } else await clickEnter();
    await sleep(1400);
  }
  const ok = await has("メインメニュー");
  if (!ok) log("---- 到達できなかった画面 ----\n" + (await bodyText()).slice(0, 1500));
  return ok;
}

/** 「切断」の兆候が出たか（closed 通知 or 接続表示の消失） */
async function isDisconnected() {
  const t = await bodyText();
  if (/切断|closed|接続が切れ|セッションが閉じ/.test(t)) return true;
  // ランチャーへ戻る／入力欄が消える形でも切断と見る
  return (await inputs().count()) === 0;
}

/** 装置を解放して終わる（残すと次回が回復画面から始まる） */
async function signoff() {
  try {
    await runCmd("SIGNOFF");
    await sleep(1800);
  } catch (e) {
    log("SIGNOFF できなかった: " + e.message);
  }
}

try {
  // ---------- 1. 設定 UI ----------
  await page.goto(`http://localhost:${PORT}/`);
  await page.waitForSelector(".launcher", { timeout: 20000 });
  await page.click(".card:has-text('実機') >> button:has-text('選択')");
  await page.waitForSelector(".card:has-text('DEV1-1MIN')", { timeout: 10000 });
  await page.click(".card:has-text('DEV1-1MIN') >> button:has-text('編集')");
  await sleep(600);
  const sel = page.locator("select").filter({ hasText: "サーバー既定に従う" }).first();
  const opts = await sel.locator("option").allInnerTexts();
  check("設定フォームに「無操作で切る」がある", (await sel.count()) === 1);
  check(
    "選択肢に「サーバー既定に従う」「切らない」と分がある",
    opts.includes("サーバー既定に従う") && opts.includes("切らない") && opts.some((o) => /分$/.test(o)),
    opts.join(" / ")
  );
  const cur = await sel.inputValue();
  check("設定ファイルに書いた 1 分が選択されている（空欄にならない）", cur === "1", JSON.stringify(cur));
  await shot("01-settings-form");
  const cancel = page.getByRole("button", { name: /取消|キャンセル/ }).first();
  if (await cancel.count()) await cancel.click();
  await sleep(400);

  // ---------- 2. 既定（永続）: 110 秒放置しても切れない ＋ 心拍の往復 ----------
  log("== phase 2: 既定（永続）で 110 秒放置 ==");
  check("DEV1（既定）でメインメニューに到達", await connect("DEV1"));
  await shot("02-connected-default");
  const t0 = Date.now();
  let deadDefault = false;
  while (Date.now() - t0 < 110_000) {
    await sleep(5000);
    if (await isDisconnected()) {
      deadDefault = true;
      break;
    }
  }
  const elapsed2 = Math.round((Date.now() - t0) / 1000);
  check(`既定は ${elapsed2} 秒放置しても切れない`, !deadDefault, `elapsed=${elapsed2}s`);
  check(
    "ハートビートの往復が成立している（90 秒無応答なら畳まれる）",
    !deadDefault && elapsed2 >= 100,
    `elapsed=${elapsed2}s`
  );
  await shot("03-alive-after-110s-idle");
  await signoff();

  // ---------- 3. 有限値（1 分）× 打鍵継続: 切れない ----------
  log("== phase 3: 1 分設定で 95 秒打鍵し続ける（AID は押さない） ==");
  check("DEV1-1MIN でメインメニューに到達", await connect("DEV1-1MIN"));
  const cmd = inputs().last();
  await cmd.click();
  await page.keyboard.press("Home");
  const t1 = Date.now();
  let deadTyping = false;
  while (Date.now() - t1 < 95_000) {
    // **AID キーは送らない。** 打鍵だけで在席が伝わるかを見る（合図は 15 秒に間引かれる）
    await page.keyboard.press("A");
    await page.keyboard.press("Backspace");
    await sleep(5000);
    if (await isDisconnected()) {
      deadTyping = true;
      break;
    }
  }
  const elapsed3 = Math.round((Date.now() - t1) / 1000);
  check(
    `1 分設定でも打鍵していれば ${elapsed3} 秒切れない（在席の合図が効いている）`,
    !deadTyping,
    `elapsed=${elapsed3}s`
  );
  await shot("04-alive-while-typing");
  await signoff();

  // ---------- 4. 有限値（1 分）× 放置: 切れる ----------
  log("== phase 4: 1 分設定で放置して切れるのを待つ ==");
  check("DEV1-1MIN で再接続", await connect("DEV1-1MIN"));
  const t2 = Date.now();
  let deadIdle = false;
  while (Date.now() - t2 < 100_000) {
    await sleep(3000);
    if (await isDisconnected()) {
      deadIdle = true;
      break;
    }
  }
  const elapsed4 = Math.round((Date.now() - t2) / 1000);
  check(`1 分設定で放置すると切れる（${elapsed4} 秒で切断）`, deadIdle, `elapsed=${elapsed4}s`);
  check("設定した 1 分より早くは切らない", !deadIdle || elapsed4 >= 60, `elapsed=${elapsed4}s`);
  await shot("05-closed-after-idle");
} catch (e) {
  check("例外なく完走", false, e.message);
  log(e.stack ?? "");
} finally {
  await browser.close();
  server.close();
  wss.close();
  sessions.closeAll?.();
}

const failed = results.filter((r) => !r.ok);
process.stdout.write(`\n${results.length - failed.length}/${results.length} passed\n`);
process.exit(failed.length === 0 ? 0 : 1);
