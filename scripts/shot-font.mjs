import { readFileSync, writeFileSync } from "node:fs";
import { serve } from "@hono/node-server";
import { WebSocketServer } from "ws";
import { buildApp, SessionManager, ServerConfigStore, PersonalConfigStore, ConfigResolver } from "@ts5250/server";
import { SecretCrypto } from "../packages/server/dist/secret-crypto.js";
import { chromium } from "playwright";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (s) => process.stderr.write(s + "\n");
const OUT = "/tmp/ts5250-work";
const PORT = 3481;
const cfg = JSON.parse(readFileSync("connections.json", "utf8"));
const tmpCfg = `${OUT}/conn-font.json`; writeFileSync(tmpCfg, JSON.stringify(cfg));
const crypto = SecretCrypto.fromEnv();
const resolver = new ConfigResolver(ServerConfigStore.fromFile(tmpCfg, crypto), new PersonalConfigStore({ systems: [], sessions: [] }, crypto));
const sessions = new SessionManager();
const app = buildApp({ sessions, resolver, version: "shot", webRoot: "packages/web-ui/dist" });
const wss = new WebSocketServer({ noServer: true });
const server = serve({ fetch: app.fetch, port: PORT, websocket: { server: wss } });
await sleep(600);
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1400, height: 820 }, deviceScaleFactor: 2 });
const shot = async (n, loc) => { await (loc ?? page).screenshot({ path: `${OUT}/${n}` }); log("shot " + n); };
try {
  await page.goto(`http://localhost:${PORT}/`);
  await page.waitForSelector(".launcher", { timeout: 20000 });
  await page.click(".card:has-text('実機') >> button:has-text('選択')");
  await page.waitForSelector(".card:has-text('DEV1')", { timeout: 10000 });
  let ok = false;
  for (let a = 1; a <= 6 && !ok; a++) {
    await page.click(".card:has-text('DEV1') >> button:has-text('接続')");
    try { await page.waitForSelector("input.grid-input", { timeout: 18000 }); ok = true; }
    catch { log(`busy ${a}`); await sleep(12000); }
  }
  if (!ok) throw new Error("busy");
  await sleep(1200);
  // フォントの読み込みを待つ
  await page.evaluate(() => document.fonts && document.fonts.ready).catch(() => {});
  await page.evaluate(() => document.fonts.load('12px "IBM Plex Mono"')).catch(() => {});
  await sleep(500);
  log("plex loaded: " + await page.evaluate(() => document.fonts.check('12px "IBM Plex Mono"')));
  // 画面設定メニューを開く（フォント行を見せる）
  await page.locator("button.vsm-btn").first().click();
  await sleep(300);
  await shot("font-1-menu.png");
  // OIA(フッター)だけクロップ
  await page.keyboard.press("Escape"); await sleep(200);
  const oia = page.locator(".oia").first();
  if (await oia.count()) await shot("font-2-oia.png", oia);
} catch (e) { log("ERR " + e.message); await shot("font-error.png").catch(() => {}); }
finally { await browser.close(); server.close(); }
