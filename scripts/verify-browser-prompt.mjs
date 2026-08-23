// 実ブラウザ（web-ui）で実機へ接続し、**`F4` の導線**が端から端まで効くか検証する。
//
//   設定 OFF では出ない → ON にすると、凡例に `F4=…` がある画面でフォーカス中の欄の隣に出る
//   → 押すと **ホストが実際にプロンプト画面を返す**
//
// **押して本当にホストが反応するかは、ここでしか分からない。** 単体テストは
// `aid("F4")` を emit するところまでしか見ておらず、カーソル位置が保たれているか
// （＝ホストが正しい欄をプロンプトするか）は実物に聞くほかない。
//
// ラベルが地域語（実機は `F4=ﾌﾟﾛﾝﾌﾟﾄ`）で来ることも、ここで確かめる。
//
// 前提: npm run build 済み。`connections.json` に実機と DEV1。
// 実行: AS400_PASSWORD=... node scripts/verify-browser-prompt.mjs
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { serve } from "@hono/node-server";
import { WebSocketServer } from "ws";
import { buildApp, SessionManager, ServerConfigStore, PersonalConfigStore, ConfigResolver } from "@ts5250/server";
import { SecretCrypto } from "../packages/server/dist/secret-crypto.js";
import { chromium } from "playwright";

const log = (s) => process.stderr.write(s + "\n");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const PORT = 3484;
const TMP = process.env.PR_TMP ?? "/tmp/as400-verify-prompt";
const SHOTS = `${TMP}/shots`;
mkdirSync(SHOTS, { recursive: true });

const results = [];
const check = (n, ok, d = "") => {
  results.push({ n, ok });
  process.stdout.write(`${ok ? "OK  " : "NG  "} ${n}${d ? ` — ${d}` : ""}\n`);
};

const cfg = JSON.parse(readFileSync("connections.json", "utf8"));
const tmpCfg = `${TMP}/conn-prompt.json`;
writeFileSync(tmpCfg, JSON.stringify(cfg));
const crypto = SecretCrypto.fromEnv();
const sys = cfg.systems.find((s) => s.name === (process.env.AS400_SYSTEM ?? "AS400"));
const password = process.env.AS400_PASSWORD;
const user = sys.signon.user;
if (!password) { log("AS400_PASSWORD が未設定です"); process.exit(1); }

const resolver = new ConfigResolver(
  ServerConfigStore.fromFile(tmpCfg, crypto),
  new PersonalConfigStore({ systems: [], sessions: [] }, crypto)
);
const app = buildApp({ sessions: new SessionManager(), resolver, version: "verify", webRoot: "packages/web-ui/dist" });
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
  await page.screenshot({ path: `${SHOTS}/${name}.png` });
  log(`shot: ${SHOTS}/${name}.png`);
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
  await sleep(1800);
}
/**
 * 画面設定メニューから項目を切り替える。
 * DOM は `ViewSettingsMenu.vue`（`.vsm-btn` → `.vsm-row` に `.vsm-label` と `.seg` のボタン）。
 */
async function setView(label, value) {
  await page.click(".vsm-btn");
  await page.waitForSelector(".vsm-menu", { timeout: 5000 });
  const row = page.locator(".vsm-row", { hasText: label }).first();
  await row.locator(".seg button", { hasText: value }).first().click();
  await sleep(300);
  await page.click(".vsm-btn"); // 閉じる
  await sleep(300);
}

try {
  await page.goto(`http://localhost:${PORT}/`);
  await page.waitForSelector(".launcher", { timeout: 20000 });
  await page.click(".card:has-text('実機') >> button:has-text('選択')");
  await page.waitForSelector(".card:has-text('DEV1')", { timeout: 10000 });
  await page.click(".card:has-text('DEV1') >> button:has-text('接続')");
  await page.waitForFunction(
    () => /サインオン|ユーザー|回復|メインメニュー/.test(document.body.innerText),
    { timeout: 25000 }
  );
  await sleep(900);
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
  check("メインメニューに到達", await has("メインメニュー"));

  // メインメニューの凡例には `F4=ﾌﾟﾛﾝﾌﾟﾄ` がある（地域語で来る）
  const legendText = await bodyText();
  check("凡例に F4 がある画面", /F4=/.test(legendText), (legendText.match(/F4=\S*/) ?? [""])[0]);

  // --- 設定 OFF では出ない ---
  const cmd = inputs().last();
  await cmd.click();
  await sleep(400);
  check("設定 OFF ではボタンが出ない", (await page.locator(".prompt-btn").count()) === 0);
  await shot("01-off");

  // --- ON にする ---
  await setView("F4 の導線", "ON");
  await cmd.click();
  await sleep(500);
  const n = await page.locator(".prompt-btn").count();
  check("設定 ON でフォーカス中の欄にボタンが出る", n === 1, `count=${n}`);
  const title = await page.locator(".prompt-btn").first().getAttribute("title");
  check("ラベルはホストの凡例の語（地域語）", Boolean(title) && title !== "F4 を送る", JSON.stringify(title));
  await shot("02-on-button");

  // --- 押すとホストがプロンプト画面を返す ---
  await page.locator(".prompt-btn").first().click();
  await sleep(2500);
  const after = await bodyText();
  // メインメニューのコマンド行で F4 を押すと「コマンドの選択」（MAJOR コマンド分類）が出る
  const moved = !after.includes("IBM I メインメニュー") || after.includes("選択");
  check("押すとホストが応答して画面が変わる", moved, after.split("\n").find((l) => l.trim()) ?? "");
  await shot("03-after-f4");

  await page.keyboard.press("F3");
  await sleep(1500);
  try {
    await runCmd("SIGNOFF");
  } catch (e) {
    log("SIGNOFF できなかった: " + e.message);
  }
} catch (e) {
  check("例外なく完走", false, e.message);
  log(e.stack ?? "");
} finally {
  await browser.close();
  server.close();
  wss.close();
}

const failed = results.filter((r) => !r.ok);
process.stdout.write(`\n${results.length - failed.length}/${results.length} passed\n`);
process.exit(failed.length === 0 ? 0 : 1);
