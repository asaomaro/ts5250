// 実ブラウザ(web-ui)で実機へ接続し、画面設定の「配色(端末色/意味色)」と
// 「画面の質感(CRT/フラット)」の before/after を撮る。
// 前提: npm run build 済み。実行: node --env-file=.env scripts/shot-viewsettings.mjs
import { readFileSync, writeFileSync } from "node:fs";
import { serve } from "@hono/node-server";
import { WebSocketServer } from "ws";
import { buildApp, SessionManager, ServerConfigStore, PersonalConfigStore, ConfigResolver } from "@ts5250/server";
import { SecretCrypto } from "../packages/server/dist/secret-crypto.js";
import { chromium } from "playwright";

const log = (s) => process.stderr.write(s + "\n");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const OUT = "/tmp/claude-1000/-workspaces-as400-web-emulator/cff7c584-0ab5-4be3-b08e-bc65bf027295/scratchpad";
const PORT = 3477;

const cfg = JSON.parse(readFileSync("connections.json", "utf8"));
const tmpCfg = `${OUT}/conn-vs.json`;
writeFileSync(tmpCfg, JSON.stringify(cfg));
const crypto = SecretCrypto.fromEnv();
const resolver = new ConfigResolver(ServerConfigStore.fromFile(tmpCfg, crypto), new PersonalConfigStore({ systems: [], sessions: [] }, crypto));
const sessions = new SessionManager();
const app = buildApp({ sessions, resolver, version: "shot", webRoot: "packages/web-ui/dist" });
const wss = new WebSocketServer({ noServer: true });
const server = serve({ fetch: app.fetch, port: PORT, websocket: { server: wss } });
await sleep(600);

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1400, height: 820 }, deviceScaleFactor: 2 });
page.on("pageerror", (e) => log("PAGEERR " + e.message));
const bodyText = () => page.locator("body").innerText();
const has = async (t) => (await bodyText()).includes(t);
const clickEnter = async () => { const b = page.getByText("⏎ 実行", { exact: false }).first(); if (await b.count()) await b.click(); else await page.keyboard.press("Enter"); };
const shot = async (name) => { const p = `${OUT}/${name}`; await page.screenshot({ path: p }); log("shot: " + p); };
const type = async (text) => { const inp = page.locator("input.grid-input").first(); await inp.click(); await page.keyboard.press("Home"); await page.keyboard.type(text, { delay: 25 }); };

// 画面設定ポップオーバーで、ある行(label)のオプション(optLabel)を選ぶ
async function pickSetting(rowLabel, optLabel) {
  const btn = page.locator("button.vsm-btn").first();
  await btn.click();
  await sleep(200);
  const row = page.locator(".vsm-row", { hasText: rowLabel }).first();
  await row.locator("button", { hasText: new RegExp(`^${optLabel}$`) }).first().click();
  await sleep(150);
  // ポップオーバーを閉じる（画面本体をクリック）
  await page.keyboard.press("Escape");
  await sleep(400);
}

try {
  await page.goto(`http://localhost:${PORT}/`);
  await page.waitForSelector(".launcher", { timeout: 20000 });
  await page.click(".card:has-text('実機') >> button:has-text('選択')");
  await page.waitForSelector(".card:has-text('DEV1')", { timeout: 10000 });

  // 装置 DEV1 は前ジョブが掴んでいると "socket closed / 使用中" で落ちる。数十秒で解放されるのでリトライ。
  // 接続成功＝エミュレーター画面(input.grid-input)が出た、で判定する
  // （ランチャーの "ユーザー" カード等に誤マッチしないため本文テキストでは判定しない）。
  let connected = false;
  for (let attempt = 1; attempt <= 6 && !connected; attempt++) {
    await page.click(".card:has-text('DEV1') >> button:has-text('接続')");
    try {
      await page.waitForSelector("input.grid-input", { timeout: 18000 });
      connected = true;
    } catch {
      const busy = await has("SESSION_CLOSED") || await has("使用中");
      log(`connect attempt ${attempt} failed (busy=${busy}); waiting…`);
      await sleep(12000); // 装置ロックの解放待ち
    }
  }
  if (!connected) throw new Error("could not connect (device DEV1 busy)");
  await sleep(900);

  // サインオン→（回復/情報）→メニュー を 1 つのループで捌く。
  // 回復のサインオフ後に再びサインオンが出ることがあるため、毎回サインオンなら資格情報を入れ直す。
  async function signOn() {
    const inputs = page.locator("input.grid-input");
    await inputs.nth(0).click(); await page.keyboard.press("Home");
    await inputs.nth(0).pressSequentially("USER", { delay: 45 });
    await sleep(120);
    await inputs.nth(1).click(); await page.keyboard.press("Home");
    await inputs.nth(1).pressSequentially("PASSWORD", { delay: 45 });
    await sleep(180);
    await clickEnter();
  }
  for (let i = 0; i < 12; i++) {
    if (await has("メインメニュー")) break;
    if (await has("サイン") && (await page.locator("input.grid-input").count()) >= 2) { await signOn(); await sleep(1400); continue; }
    if (await has("対話式ジョブの回復") || await has("中断されました")) { await type("90"); await clickEnter(); await sleep(1400); continue; } // 90=サインオフ→クリーンなサインオンへ
    await clickEnter();
    await sleep(1300);
  }
  const reached = await has("メインメニュー");
  log("menu reached: " + reached);
  log("vsm buttons: " + await page.locator("button.vsm-btn").count());
  log("key button: " + await page.locator("button.theme-btn:has-text('キー')").count());
  if (!reached) { log("WARN: still at " + (await bodyText()).slice(0, 40).replace(/\n/g, " ")); }

  // ---- コントロール表現 4種（入力欄のあるメインメニューで撮る）----
  // 先頭の入力欄にフォーカスしてフォーカス演出も見せる
  const focusField = async () => { const i = page.locator("input.grid-input:not([readonly])").first(); if (await i.count()) await i.click(); };
  await focusField();
  await shot("ctl-1-plain.png");
  await pickSetting("コントロール表現", "下線"); await focusField(); await shot("ctl-2-underline.png");
  await pickSetting("コントロール表現", "塗り"); await focusField(); await shot("ctl-3-filled.png");
  await pickSetting("コントロール表現", "枠"); await focusField(); await shot("ctl-4-rich.png");
  // メニューを開いた状態（新しい4択セグメントを見せる）
  await pickSetting("コントロール表現", "プレーン");
  await page.locator("button.vsm-btn").first().click();
  await sleep(250);
  await shot("ctl-5-menu-open.png");
} catch (e) {
  log("SHOT ERROR: " + e.message);
  await shot("vs-error.png").catch(() => {});
} finally {
  await browser.close();
  server.close();
}
