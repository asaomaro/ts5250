import { readFileSync, writeFileSync } from "node:fs";
import { serve } from "@hono/node-server";
import { WebSocketServer } from "ws";
import { buildApp, SessionManager, ServerConfigStore, PersonalConfigStore, ConfigResolver } from "@as400web/server";
import { SecretCrypto } from "../packages/server/dist/secret-crypto.js";
import { chromium } from "playwright";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (s) => process.stderr.write(s + "\n");
const OUT = "/tmp/claude-1000/-workspaces-as400-web-emulator/cff7c584-0ab5-4be3-b08e-bc65bf027295/scratchpad";
const PORT = 3483;
const cfg = JSON.parse(readFileSync("connections.json", "utf8"));
writeFileSync(`${OUT}/conn-x.json`, JSON.stringify(cfg));
const crypto = SecretCrypto.fromEnv();
const resolver = new ConfigResolver(ServerConfigStore.fromFile(`${OUT}/conn-x.json`, crypto), new PersonalConfigStore({ systems: [], sessions: [] }, crypto));
const app = buildApp({ sessions: new SessionManager(), resolver, version: "shot", webRoot: "packages/web-ui/dist" });
const wss = new WebSocketServer({ noServer: true });
const server = serve({ fetch: app.fetch, port: PORT, websocket: { server: wss } });
await sleep(600);
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1400, height: 820 }, deviceScaleFactor: 2 });
const vis = async (sel) => page.locator(sel).count();
try {
  await page.goto(`http://localhost:${PORT}/`);
  await page.waitForSelector(".launcher", { timeout: 20000 });
  await page.click(".card:has-text('実機') >> button:has-text('選択')");
  await page.waitForSelector(".card:has-text('DEV1')", { timeout: 10000 });
  let ok = false;
  for (let a = 1; a <= 8 && !ok; a++) {
    await page.click(".card:has-text('DEV1') >> button:has-text('接続')");
    try { await page.waitForSelector("input.grid-input", { timeout: 16000 }); ok = true; } catch { log(`busy ${a}`); await sleep(11000); }
  }
  if (!ok) throw new Error("busy");
  await sleep(1000);
  // 1) デザインを開く
  await page.click(".dz-btn"); await sleep(300);
  log(`after design click:  dz-menu=${await vis(".dz-menu")} vsm-menu=${await vis(".vsm-menu")}`);
  // 2) 画面設定を開く → デザインは閉じるはず
  await page.click(".vsm-btn"); await sleep(300);
  log(`after 画面 click:     dz-menu=${await vis(".dz-menu")} vsm-menu=${await vis(".vsm-menu")}`);
  await page.screenshot({ path: `${OUT}/menu-exclusive.png` });
  // 3) もう一度デザイン → 画面は閉じるはず
  await page.click(".dz-btn"); await sleep(300);
  log(`after design click2: dz-menu=${await vis(".dz-menu")} vsm-menu=${await vis(".vsm-menu")}`);
} catch (e) { log("ERR " + e.message); }
finally { await browser.close(); server.close(); }
