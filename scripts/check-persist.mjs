import { readFileSync, writeFileSync } from "node:fs";
import { serve } from "@hono/node-server";
import { WebSocketServer } from "ws";
import { buildApp, SessionManager, ServerConfigStore, PersonalConfigStore, ConfigResolver } from "@ts5250/server";
import { SecretCrypto } from "../packages/server/dist/secret-crypto.js";
import { chromium } from "playwright";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (s) => process.stderr.write(s + "\n");
const OUT = "/tmp/claude-1000/-workspaces-as400-web-emulator/cff7c584-0ab5-4be3-b08e-bc65bf027295/scratchpad";
const PORT = 3485;
const cfg = JSON.parse(readFileSync("connections.json", "utf8"));
writeFileSync(`${OUT}/conn-p.json`, JSON.stringify(cfg));
const crypto = SecretCrypto.fromEnv();
const resolver = new ConfigResolver(ServerConfigStore.fromFile(`${OUT}/conn-p.json`, crypto), new PersonalConfigStore({ systems: [], sessions: [] }, crypto));
const app = buildApp({ sessions: new SessionManager(), resolver, version: "shot", webRoot: "packages/web-ui/dist" });
const wss = new WebSocketServer({ noServer: true });
const server = serve({ fetch: app.fetch, port: PORT, websocket: { server: wss } });
await sleep(600);
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1400, height: 820 }, deviceScaleFactor: 2 });
const page = await ctx.newPage();
const connect = async () => {
  await page.waitForSelector(".launcher", { timeout: 20000 });
  await page.click(".card:has-text('実機') >> button:has-text('選択')");
  await page.waitForSelector(".card:has-text('DEV1')", { timeout: 10000 });
  for (let a = 1; a <= 8; a++) {
    await page.click(".card:has-text('DEV1') >> button:has-text('接続')");
    try { await page.waitForSelector("input.grid-input", { timeout: 15000 }); return true; } catch { log(`busy ${a}`); await sleep(11000); }
  }
  return false;
};
const ls = () => page.evaluate(() => localStorage.getItem("as400.view.defaults"));
try {
  await page.goto(`http://localhost:${PORT}/`);
  if (!await connect()) throw new Error("busy");
  await sleep(800);
  log("localStorage before: " + await ls());
  // 画面設定を開いて 配色→意味色, 質感→フラット に変更
  await page.click(".vsm-btn"); await sleep(300);
  await page.locator(".vsm-row", { hasText: "配色" }).locator("button", { hasText: /^意味色$/ }).click(); await sleep(150);
  await page.locator(".vsm-row", { hasText: "画面の質感" }).locator("button", { hasText: /^フラット$/ }).click(); await sleep(150);
  log("localStorage after change: " + await ls());
  // 再読み込み → 再接続 → メニューを開いて 意味色/フラット が選択状態か
  await page.reload();
  log("localStorage after reload: " + await ls());
  if (!await connect()) throw new Error("busy after reload");
  await sleep(800);
  await page.click(".vsm-btn"); await sleep(300);
  const semanticOn = await page.locator(".vsm-row", { hasText: "配色" }).locator("button.on", { hasText: /^意味色$/ }).count();
  const flatOn = await page.locator(".vsm-row", { hasText: "画面の質感" }).locator("button.on", { hasText: /^フラット$/ }).count();
  log(`RESULT after reload: 意味色 selected=${semanticOn}  フラット selected=${flatOn}`);
} catch (e) { log("ERR " + e.message); }
finally { await browser.close(); server.close(); }
