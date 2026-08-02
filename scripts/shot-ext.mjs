// 実ブラウザ(web-ui, enhanced=true)で実機へ接続し、EXTPGM の拡張5250 GUI を撮る。
// 実行: node --env-file=.env scripts/shot-ext.mjs
import { readFileSync, writeFileSync } from "node:fs";
import { serve } from "@hono/node-server";
import { WebSocketServer } from "ws";
import { buildApp, SessionManager, ServerConfigStore, PersonalConfigStore, ConfigResolver } from "@ts5250/server";
import { SecretCrypto } from "../packages/server/dist/secret-crypto.js";
import { chromium } from "playwright";

const log = (s) => process.stderr.write(s + "\n");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const OUT = "/tmp/claude-1000/-workspaces-as400-web-emulator/cff7c584-0ab5-4be3-b08e-bc65bf027295/scratchpad";
const PORT = 3507;

// DEV1 セッションに enhanced=true を付けて拡張5250 を広告する
const cfg = JSON.parse(readFileSync("connections.json", "utf8"));
for (const s of cfg.sessions) if (s.name === "DEV1") s.enhanced = true;
const tmpCfg = `${OUT}/conn-ext.json`;
writeFileSync(tmpCfg, JSON.stringify(cfg));
const crypto = SecretCrypto.fromEnv();
const resolver = new ConfigResolver(ServerConfigStore.fromFile(tmpCfg, crypto), new PersonalConfigStore({ systems: [], sessions: [] }, crypto));
const sessions = new SessionManager();
const app = buildApp({ sessions, resolver, version: "shot", webRoot: "packages/web-ui/dist" });
const wss = new WebSocketServer({ noServer: true });
const server = serve({ fetch: app.fetch, port: PORT, websocket: { server: wss } });
await sleep(600);

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1400, height: 760 }, deviceScaleFactor: 2 });
page.on("pageerror", (e) => log("PAGEERR " + e.message));
const bodyText = () => page.locator("body").innerText();
const has = async (t) => (await bodyText()).includes(t);
const clickEnter = async () => { const b = page.getByText("⏎ 実行", { exact: false }).first(); if (await b.count()) await b.click(); else await page.keyboard.press("Enter"); };
const clickF = async (label) => { const b = page.getByText(label, { exact: false }).first(); if (await b.count()) await b.click(); };
const shot = async (name) => { const p = `${OUT}/${name}`; await page.screenshot({ path: p }); log("shot: " + p); };
const type = async (text) => { const inp = page.locator("input.grid-input").first(); await inp.click(); await page.keyboard.press("Home"); await page.keyboard.type(text, { delay: 25 }); };

try {
  await page.goto(`http://localhost:${PORT}/`);
  await page.waitForSelector(".launcher", { timeout: 20000 });
  await page.click(".card:has-text('実機') >> button:has-text('選択')");
  await page.waitForSelector(".card:has-text('DEV1')", { timeout: 10000 });
  await page.click(".card:has-text('DEV1') >> button:has-text('接続')");
  await page.waitForFunction(() => document.body.innerText.includes("サインオン") || document.body.innerText.includes("ユーザー") || document.body.innerText.includes("回復"), { timeout: 25000 });
  await sleep(900);
  for (let i = 0; i < 12; i++) {
    if (await has("メインメニュー")) break;
    if ((await has("サイン") && await has("オン")) || await has("パスワード")) {
      const inputs = page.locator("input.grid-input");
      if (await inputs.count() >= 2) {
        await inputs.nth(0).pressSequentially("USER", { delay: 45 });
        await sleep(120);
        await inputs.nth(1).pressSequentially("PASSWORD", { delay: 45 });
        await sleep(150);
        await clickEnter();
      } else await clickEnter();
    } else if (await has("対話式ジョブの回復")) { await type("90"); await clickEnter(); }
    else await clickEnter();
    await sleep(1300);
  }
  log("menu reached: " + (await has("メインメニュー")));

  // ボタン設定を有効化（枠）してから拡張5250 の画面へ
  await page.locator("button.vsm-btn").first().click(); await sleep(300);
  await page.locator(".vsm-row", { hasText: "ボタン設定" }).first().locator(".vsm-toggle").click(); await sleep(300);
  await page.locator(".pal-item", { hasText: "枠" }).first().click(); await sleep(300);
  // ウィンドウ設定も「影＋スモーク」にする
  await page.locator(".vsm-row", { hasText: "ウィンドウ設定" }).first().locator(".vsm-toggle").click(); await sleep(300);
  await page.locator(".pal-item", { hasText: "影＋スモーク" }).first().click(); await sleep(300);
  await page.keyboard.press("Escape"); await sleep(400);

  await type("ADDLIBLE TESTLIB"); await clickEnter(); await sleep(1200);
  await type("CALL TESTLIB/EXTPGM"); await clickEnter(); await sleep(1600);
  await shot("ext-1-scrollbar.png");   // subfile + scrollbar
  await clickEnter(); await sleep(1600);
  const btns = await page.locator("button.fkey-btn").allTextContents();
  log("WINDOW 画面のボタン: " + btns.length + " → " + btns.map((t) => JSON.stringify(t)).join(" "));
  log("WINDOW 画面の装飾: deco=" + await page.locator(".win-deco").count() + " smoke=" + await page.locator(".win-smoke").count());
  await shot("ext-2-window.png");      // WINDOW popup
  await clickF("F12"); await sleep(600);
} catch (e) {
  log("SHOT ERROR: " + e.message);
  await shot("ext-error.png").catch(() => {});
} finally {
  await browser.close();
  server.close();
}
