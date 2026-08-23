import { readFileSync, writeFileSync } from "node:fs";
import { serve } from "@hono/node-server";
import { WebSocketServer } from "ws";
import { buildApp, SessionManager, ServerConfigStore, PersonalConfigStore, ConfigResolver } from "@ts5250/server";
import { SecretCrypto } from "../packages/server/dist/secret-crypto.js";
import { chromium } from "playwright";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (s) => process.stderr.write(s + "\n");
const OUT = "/tmp/ts5250-work";
const PORT = 3487;
const cfg = JSON.parse(readFileSync("connections.json", "utf8"));
writeFileSync(`${OUT}/conn-crt.json`, JSON.stringify(cfg));
const crypto = SecretCrypto.fromEnv();
const resolver = new ConfigResolver(ServerConfigStore.fromFile(`${OUT}/conn-crt.json`, crypto), new PersonalConfigStore({ systems: [], sessions: [] }, crypto));
const app = buildApp({ sessions: new SessionManager(), resolver, version: "shot", webRoot: "packages/web-ui/dist" });
const wss = new WebSocketServer({ noServer: true });
const server = serve({ fetch: app.fetch, port: PORT, websocket: { server: wss } });
await sleep(600);
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1400, height: 820 }, deviceScaleFactor: 2 });
const shot = async (n, loc) => { await (loc ?? page).screenshot({ path: `${OUT}/${n}` }); log("shot " + n); };
async function pick(row, opt) {
  await page.locator("button.vsm-btn").first().click(); await sleep(250);
  await page.locator(".vsm-row", { hasText: row }).locator("button", { hasText: new RegExp(`^${opt}$`) }).click(); await sleep(150);
  await page.keyboard.press("Escape"); await sleep(400);
}
try {
  await page.goto(`http://localhost:${PORT}/`);
  await page.waitForSelector(".launcher", { timeout: 20000 });
  await page.click(`.card:has-text('${process.env.AS400_SYSTEM ?? "AS400"}') >> button:has-text('選択')`);
  await page.waitForSelector(`.card:has-text('${process.env.AS400_SESSION ?? "DEV1"}')`, { timeout: 10000 });
  let ok=false;
  for (let a=1;a<=8&&!ok;a++){ await page.click(`.card:has-text('${process.env.AS400_SESSION ?? "DEV1"}') >> button:has-text('接続')`); try{ await page.waitForSelector("input.grid-input",{timeout:15000}); ok=true; }catch{ log(`busy ${a}`); await sleep(11000);} }
  if(!ok) throw new Error("busy");
  await sleep(1000);
  await page.locator("button.vsm-btn").first().click(); await sleep(300);
  await shot("crt-menu.png"); await page.keyboard.press("Escape"); await sleep(300);
  await pick("画面の質感","フラット"); await shot("crt-flat.png");
  await pick("画面の質感","CRT"); await shot("crt-crt.png");
} catch(e){ log("ERR "+e.message); await shot("crt-error.png").catch(()=>{}); }
finally { await browser.close(); server.close(); }
