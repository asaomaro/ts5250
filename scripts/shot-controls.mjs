// サインオン画面(通常の下線入力欄)で コントロール表現 4種を撮る。
import { readFileSync, writeFileSync } from "node:fs";
import { serve } from "@hono/node-server";
import { WebSocketServer } from "ws";
import { buildApp, SessionManager, ServerConfigStore, PersonalConfigStore, ConfigResolver } from "@ts5250/server";
import { SecretCrypto } from "../packages/server/dist/secret-crypto.js";
import { chromium } from "playwright";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (s) => process.stderr.write(s + "\n");
const OUT = "/tmp/claude-1000/-workspaces-as400-web-emulator/cff7c584-0ab5-4be3-b08e-bc65bf027295/scratchpad";
const PORT = 3479;
const cfg = JSON.parse(readFileSync("connections.json", "utf8"));
const tmpCfg = `${OUT}/conn-ctl.json`; writeFileSync(tmpCfg, JSON.stringify(cfg));
const crypto = SecretCrypto.fromEnv();
const resolver = new ConfigResolver(ServerConfigStore.fromFile(tmpCfg, crypto), new PersonalConfigStore({ systems: [], sessions: [] }, crypto));
const sessions = new SessionManager();
const app = buildApp({ sessions, resolver, version: "shot", webRoot: "packages/web-ui/dist" });
const wss = new WebSocketServer({ noServer: true });
const server = serve({ fetch: app.fetch, port: PORT, websocket: { server: wss } });
await sleep(600);
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1400, height: 820 }, deviceScaleFactor: 2 });
const has = async (t) => (await page.locator("body").innerText()).includes(t);
const shot = async (n) => { await page.screenshot({ path: `${OUT}/${n}` }); log("shot " + n); };
async function pick(rowLabel, optLabel) {
  await page.locator("button.vsm-btn").first().click(); await sleep(200);
  const row = page.locator(".vsm-row", { hasText: rowLabel }).first();
  await row.locator("button", { hasText: new RegExp(`^${optLabel}$`) }).first().click(); await sleep(150);
  await page.keyboard.press("Escape"); await sleep(300);
}
const focusField = async () => { const i = page.locator("input.grid-input:not([readonly])").first(); if (await i.count()) { await i.click(); await sleep(150); } };
try {
  await page.goto(`http://localhost:${PORT}/`);
  await page.waitForSelector(".launcher", { timeout: 20000 });
  await page.click(".card:has-text('実機') >> button:has-text('選択')");
  await page.waitForSelector(".card:has-text('DEV1')", { timeout: 10000 });
  let ok = false;
  for (let a = 1; a <= 6 && !ok; a++) {
    await page.click(".card:has-text('DEV1') >> button:has-text('接続')");
    try { await page.waitForSelector("input.grid-input", { timeout: 18000 }); ok = true; }
    catch { log(`attempt ${a} busy; wait`); await sleep(12000); }
  }
  if (!ok) throw new Error("device busy");
  await sleep(1000);
  // 回復画面なら 90 でサインオフしてサインオンへ。サインオン画面(通常入力欄)で撮る。
  for (let i = 0; i < 6; i++) {
    if (await has("サイン") && !(await has("回復"))) break;
    if (await has("回復") || await has("中断されました")) {
      const inp = page.locator("input.grid-input").first(); await inp.click(); await page.keyboard.press("Home");
      await page.keyboard.type("90", { delay: 30 });
      const b = page.getByText("⏎ 実行", { exact: false }).first(); if (await b.count()) await b.click(); else await page.keyboard.press("Enter");
      await sleep(1500);
    } else await sleep(1000);
  }
  log("at signon: " + (await has("サイン")) + " vsm:" + await page.locator("button.vsm-btn").count());
  await focusField(); await shot("ctl-1-plain.png");
  await pick("コントロール表現", "下線"); await focusField(); await shot("ctl-2-underline.png");
  await pick("コントロール表現", "塗り"); await focusField(); await shot("ctl-3-filled.png");
  await pick("コントロール表現", "枠"); await focusField(); await shot("ctl-4-rich.png");
} catch (e) { log("ERR " + e.message); await shot("ctl-error.png").catch(() => {}); }
finally { await browser.close(); server.close(); }
