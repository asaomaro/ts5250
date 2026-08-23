// 画面設定の「フォント（画面）」欄を実ブラウザで撮る。
// インストール済みフォントの列挙（Local Font Access）は headless では効かないので、
// **queryLocalFonts を差し込んで**一覧つきの見た目も確認する。
// 設定メニューはエミュレーター画面（セッション）のヘッダーに出るので、実機へ 1 本繋ぐ。
//   AS400_USER=... AS400_PASSWORD=... node --env-file=.env --env-file=.env.verify scripts/shot-fontmenu.mjs
import { serve } from "@hono/node-server";
import { WebSocketServer } from "ws";
import { buildApp, SessionManager, ServerConfigStore, PersonalConfigStore, ConfigResolver } from "@ts5250/server";
import { SecretCrypto } from "../packages/server/dist/secret-crypto.js";
import { readFileSync, writeFileSync } from "node:fs";
import { chromium } from "playwright";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (s) => process.stderr.write(s + "\n");
const OUT = process.env.SHOT_OUT ?? "/tmp";
const PORT = 3494;

writeFileSync(`${OUT}/conn-fontmenu.json`, readFileSync("connections.json", "utf8"));
const crypto = SecretCrypto.fromEnv();
const resolver = new ConfigResolver(
  ServerConfigStore.fromFile(`${OUT}/conn-fontmenu.json`, crypto),
  new PersonalConfigStore({ systems: [], sessions: [] }, crypto)
);
const app = buildApp({ sessions: new SessionManager(), resolver, version: "shot", webRoot: "packages/web-ui/dist" });
const wss = new WebSocketServer({ noServer: true });
serve({ fetch: app.fetch, port: PORT, websocket: { server: wss } });
await sleep(600);

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1200, height: 900 }, deviceScaleFactor: 2 });
try {
  // headless には Local Font Access が無い。実機の Chromium で見える形を再現するために差し込む
  await page.addInitScript(() => {
    Object.defineProperty(globalThis, "queryLocalFonts", {
      value: async () => [
        { family: "Cica", fullName: "Cica Regular" },
        { family: "Cica", fullName: "Cica Bold" },
        { family: "BIZ UDGothic", fullName: "BIZ UDGothic" },
        { family: "Meiryo", fullName: "Meiryo" },
        { family: "Yu Gothic", fullName: "Yu Gothic Regular" },
        { family: "Segoe UI", fullName: "Segoe UI" }
      ]
    });
  });
  await page.goto(`http://localhost:${PORT}/`);
  await page.waitForSelector(".launcher", { timeout: 20000 });
  await page.click(`.card:has-text('${process.env.AS400_SYSTEM ?? "AS400"}') >> button:has-text('選択')`);
  await page.waitForSelector(`.card:has-text('${process.env.AS400_SESSION ?? "DEV1"}')`, { timeout: 10000 });
  let ok = false;
  for (let a = 1; a <= 8 && !ok; a++) {
    await page.click(`.card:has-text('${process.env.AS400_SESSION ?? "DEV1"}') >> button:has-text('接続')`);
    try { await page.waitForSelector("input.grid-input", { timeout: 15000 }); ok = true; }
    catch { log(`装置使用中 ${a}`); await sleep(11000); }
  }
  if (!ok) throw new Error("装置が空かない");
  await page.waitForSelector("button.vsm-btn", { timeout: 20000 });
  await page.click("button.vsm-btn");
  await sleep(600);
  const menu = page.locator(".vsm-menu");
  await menu.screenshot({ path: `${OUT}/fontmenu.png` });
  const groups = await page.$$eval(".vsm-select optgroup", (gs) =>
    gs.map((g) => `${g.label}: ${[...g.children].map((o) => o.textContent.trim()).join(" / ")}`)
  );
  for (const g of groups) log(g);
  log(`撮影: ${OUT}/fontmenu.png`);
} catch (e) {
  log("失敗: " + (e?.message ?? e));
} finally {
  await browser.close();
  process.exit(0);
}
