import { readFileSync, writeFileSync } from "node:fs";
import { serve } from "@hono/node-server";
import { WebSocketServer } from "ws";
import { buildApp, SessionManager, ServerConfigStore, PersonalConfigStore, ConfigResolver } from "@ts5250/server";
import { SecretCrypto } from "../packages/server/dist/secret-crypto.js";
import { chromium } from "playwright";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (s) => process.stderr.write(s + "\n");
const OUT = "/tmp/ts5250-work";
const PORT = 3489;
const cfg = JSON.parse(readFileSync("connections.json", "utf8"));
writeFileSync(`${OUT}/conn-k.json`, JSON.stringify(cfg));
const crypto = SecretCrypto.fromEnv();
const resolver = new ConfigResolver(ServerConfigStore.fromFile(`${OUT}/conn-k.json`, crypto), new PersonalConfigStore({ systems: [], sessions: [] }, crypto));
const app = buildApp({ sessions: new SessionManager(), resolver, version: "shot", webRoot: "packages/web-ui/dist" });
const wss = new WebSocketServer({ noServer: true });
const server = serve({ fetch: app.fetch, port: PORT, websocket: { server: wss } });
await sleep(600);
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1400, height: 820 }, deviceScaleFactor: 2 });
const shot = async (n, loc) => { await (loc ?? page).screenshot({ path: `${OUT}/${n}` }); log("shot " + n); };
try {
  await page.goto(`http://localhost:${PORT}/`);
  await page.waitForSelector(".launcher", { timeout: 20000 });
  await page.click(`.card:has-text('${process.env.AS400_SYSTEM ?? "AS400"}') >> button:has-text('選択')`);
  await page.waitForSelector(`.card:has-text('${process.env.AS400_SESSION ?? "DEV1"}')`, { timeout: 10000 });
  let ok=false;
  for (let a=1;a<=8&&!ok;a++){ await page.click(`.card:has-text('${process.env.AS400_SESSION ?? "DEV1"}') >> button:has-text('接続')`); try{ await page.waitForSelector("input.grid-input",{timeout:15000}); ok=true; }catch{ log(`busy ${a}`); await sleep(11000);} }
  if(!ok) throw new Error("busy");
  await sleep(1000);

  // ヘッダーの並び順（キー が 画面 より左か）
  const order = await page.evaluate(() => {
    const t = document.querySelector(".toggles");
    return [...t.children].map(el => (el.textContent || "").trim().slice(0, 6));
  });
  log("header order: " + JSON.stringify(order));
  await shot("kc-1-header.png", page.locator(".toggles"));

  // キー設定パネル（表示設定が割当先に出るか）
  await page.click("button.theme-btn:has-text('キー')"); await sleep(400);
  const opts = await page.locator(".kb-panel optgroup[label*='表示設定'] option").allTextContents();
  log("view options: " + opts.length + " → " + opts.map(s=>s.trim().split("（")[0]).join(", "));
  await shot("kc-2-keypanel.png", page.locator(".kb-panel"));

  // ctrl+1 に 画面の質感 を割り当てて追加
  await page.click(".kb-panel .capture"); await sleep(200);
  await page.keyboard.press("Control+1"); await sleep(200);
  await page.selectOption(".kb-panel select", "view:surface"); await sleep(150);
  await page.click(".kb-panel .add"); await sleep(300);
  await shot("kc-3-bound.png", page.locator(".kb-panel"));
  await page.click(".kb-panel .x"); await sleep(400);

  // 画面をクリックしてフォーカス → ctrl+1 で順送り（通知が OIA に出るか）
  await page.locator(".pane").first().click({ position: { x: 300, y: 300 } }); await sleep(300);
  const before = await page.locator(".pane").first().getAttribute("data-surface");
  await page.keyboard.press("Control+1"); await sleep(500);
  const after = await page.locator(".pane").first().getAttribute("data-surface");
  const notice = await page.locator(".oia .notice").first().textContent().catch(()=>null);
  log(`surface: ${before} → ${after}   notice: ${JSON.stringify(notice)}`);
  await shot("kc-4-oia.png", page.locator(".oia").first());
  await shot("kc-5-full.png");
} catch(e){ log("ERR "+e.message); await shot("kc-error.png").catch(()=>{}); }
finally { await browser.close(); server.close(); }
