// クライアント側の操作員メッセージ（保護領域への入力・欄の型違反）が日本語で出るかを実画面で見る。
//   AS400_USER=... AS400_PASSWORD=... node --env-file=.env scripts/shot-opmessage.mjs
import { readFileSync, writeFileSync } from "node:fs";
import { serve } from "@hono/node-server";
import { WebSocketServer } from "ws";
import { buildApp, SessionManager, ServerConfigStore, PersonalConfigStore, ConfigResolver } from "@ts5250/server";
import { SecretCrypto } from "../packages/server/dist/secret-crypto.js";
import { chromium } from "playwright";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (s) => process.stderr.write(s + "\n");
const OUT = process.env.SHOT_OUT ?? "/tmp";
const PORT = 3493;

const cfg = JSON.parse(readFileSync("connections.json", "utf8"));
writeFileSync(`${OUT}/conn-opmsg.json`, JSON.stringify(cfg));
const crypto = SecretCrypto.fromEnv();
const resolver = new ConfigResolver(
  ServerConfigStore.fromFile(`${OUT}/conn-opmsg.json`, crypto),
  new PersonalConfigStore({ systems: [], sessions: [] }, crypto)
);
const app = buildApp({ sessions: new SessionManager(), resolver, version: "shot", webRoot: "packages/web-ui/dist" });
const wss = new WebSocketServer({ noServer: true });
serve({ fetch: app.fetch, port: PORT, websocket: { server: wss } });
await sleep(600);

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1400, height: 820 }, deviceScaleFactor: 2 });
const noticeText = () =>
  page.evaluate(() => document.querySelector(".msg.notice")?.textContent?.trim() ?? "(なし)");
try {
  await page.goto(`http://localhost:${PORT}/`);
  await page.waitForSelector(".launcher", { timeout: 20000 });
  await page.click(".card:has-text('実機') >> button:has-text('選択')");
  await page.waitForSelector(".card:has-text('DEV1')", { timeout: 10000 });
  let ok = false;
  for (let a = 1; a <= 8 && !ok; a++) {
    await page.click(".card:has-text('DEV1') >> button:has-text('接続')");
    try { await page.waitForSelector("input.grid-input", { timeout: 15000 }); ok = true; }
    catch { log(`装置使用中 ${a}`); await sleep(11000); }
  }
  if (!ok) throw new Error("装置が空かない");
  await sleep(1200);
  for (let i = 0; i < 8; i++) {
    const t = await page.locator(".pane").innerText();
    if (t.includes("コマンドを入力")) break;
    if (t.includes("サイン・オン")) {
      await page.keyboard.type(process.env.AS400_USER);
      await page.keyboard.press("Tab");
      await page.keyboard.type(process.env.AS400_PASSWORD);
    } else if (t.includes("回復")) {
      await page.keyboard.type("90");
    }
    await page.keyboard.press("Enter");
    await sleep(3000);
  }

  // ① 保護領域へカーソルを上げてから打鍵する（メニュー本文は入力欄ではない）
  for (let i = 0; i < 6; i++) await page.keyboard.press("ArrowUp");
  await sleep(300);
  await page.keyboard.press("A");
  await sleep(400);
  log(`① 保護領域への打鍵: ${await noticeText()}`);
  await page.locator(".pane").screenshot({ path: `${OUT}/opmsg-protected.png` });

  log(`撮影: ${OUT}/opmsg-protected.png`);
  // 欄の型違反（数字項目・半角項目・全角専用項目）のメッセージはここでは撮らない——
  // Playwright の keyboard.type は全角を keydown として送らないため、実 IME（CDP）が要る。
  // そちらは verify-browser-dbcs.mjs（実 IME）と web-ui の
  // paste-input-validation.test.ts（コンポーネント）で押さえている。
} finally {
  await browser.close();
  process.exit(0);
}
