// 実ブラウザ（web-ui）で実機へ接続し、EMPSFR のサブファイル画面を
// 先頭ページ／最終ページでスクリーンショットする。
// 前提: npm run build（web-ui dist）済み。実行: node --env-file=.env --env-file=.env.verify scripts/shot-empsfl.mjs
import { readFileSync, writeFileSync } from "node:fs";
import { serve } from "@hono/node-server";
import { WebSocketServer } from "ws";
import { buildApp, SessionManager, ServerConfigStore, PersonalConfigStore, ConfigResolver } from "@ts5250/server";
import { SecretCrypto } from "../packages/server/dist/secret-crypto.js";
import { chromium } from "playwright";

const log = (s) => process.stderr.write(s + "\n");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const OUT = "/tmp/ts5250-work";
const PORT = 3471;

// connections.json をコピーし、装置名をユニークにして読み込む（装置名重複の回復画面を避ける）
const cfg = JSON.parse(readFileSync("connections.json", "utf8"));
const dev = ("WEBSH" + String(Date.now()).slice(-4)).slice(0, 10);
for (const s of cfg.sessions) if (s.name === (process.env.AS400_SESSION ?? "DEV1")) s.deviceName = dev;
const tmpCfg = `${OUT}/conn-shot.json`;
writeFileSync(tmpCfg, JSON.stringify(cfg));

const crypto = SecretCrypto.fromEnv();
const resolver = new ConfigResolver(
  ServerConfigStore.fromFile(tmpCfg, crypto),
  new PersonalConfigStore({ systems: [], sessions: [] }, crypto)
);
const sessions = new SessionManager();
const app = buildApp({ sessions, resolver, version: "shot", webRoot: "packages/web-ui/dist" });
const wss = new WebSocketServer({ noServer: true });
const server = serve({ fetch: app.fetch, port: PORT, websocket: { server: wss } });
await sleep(600);

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1500, height: 780 }, deviceScaleFactor: 2 });
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));

const gridText = async () => await page.locator("body").innerText();
const clickEnter = async () => { const b = page.getByText("⏎ 実行", { exact: false }).first(); if (await b.count()) await b.click(); else await page.keyboard.press("Enter"); };
const shot = async (name) => { const p = `${OUT}/${name}`; await page.screenshot({ path: p }); log("shot: " + p); return p; };

try {
  await page.goto(`http://localhost:${PORT}/`);
  await page.waitForSelector(".launcher", { timeout: 20000 });
  log("app loaded");
  // システム実機を選択 → セッション DEV1 に接続
  await page.click(".card:has-text('実機') >> button:has-text('選択')");
  await page.waitForSelector(".card:has-text('DEV1')", { timeout: 10000 });
  await page.click(".card:has-text('DEV1') >> button:has-text('接続')");
  // サインオン画面が出るまで待つ
  await page.waitForFunction(() => document.body.innerText.includes("サインオン") || document.body.innerText.includes("ユーザー"), { timeout: 25000 });
  log("signon screen");
  await sleep(800);

  // ユーザー欄(nth0)・パスワード欄(nth1)へ直接入力 → Enter
  await page.waitForSelector("input.grid-input", { timeout: 15000 });
  await sleep(500);
  const inputs = page.locator("input.grid-input");
  log("grid-input count = " + (await inputs.count()));
  await inputs.nth(0).pressSequentially("USER", { delay: 50 });
  await sleep(150);
  await inputs.nth(1).pressSequentially("PASSWORD", { delay: 50 });
  await sleep(300);
  await shot("debug-signon.png");
  log("nth0=" + JSON.stringify(await inputs.nth(0).inputValue()) + " nth1=" + JSON.stringify(await inputs.nth(1).inputValue()));
  await clickEnter();
  log("signon submitted");

  // 情報画面（サインオン情報／メッセージ待ち行列）を Enter で抜けてメインメニューへ
  for (let i = 0; i < 3; i++) { await sleep(1100); await clickEnter(); }
  await sleep(800);
  log("main menu reached");

  // ADDLIBLE → CALL（コマンド行 = 唯一の入力欄）
  const cmd = async (text) => {
    const inp = page.locator("input.grid-input").first();
    await inp.click();
    await page.keyboard.press("Home");
    await page.keyboard.type(text);
    await sleep(150);
    await clickEnter();
    await sleep(1400);
  };
  await cmd("ADDLIBLE TESTLIB");
  await cmd("CALL TESTLIB/EMPSFR");
  await sleep(800);
  log("subfile shown; page1 text:\n" + (await gridText()).split("\n").slice(0, 12).join("\n"));
  await shot("empsfl-page1.png");

  // 最終ページへ（PageDown をマウスホイールで送る）
  const grid = page.locator(".screen-grid, .emulator, .grid").first();
  await grid.hover().catch(() => {});
  await page.mouse.wheel(0, 300);
  await sleep(1200);
  log("page2 text:\n" + (await gridText()).split("\n").slice(0, 12).join("\n"));
  await shot("empsfl-page2.png");

  await page.getByText("F3", { exact: false }).first().click().catch(() => {});
  if (errors.length) log("PAGE ERRORS: " + errors.join(" | "));
} catch (e) {
  log("SHOT ERROR: " + e.message);
  await shot("empsfl-error.png").catch(() => {});
  if (errors.length) log("PAGE ERRORS: " + errors.join(" | "));
} finally {
  await browser.close();
  server.close();
}
