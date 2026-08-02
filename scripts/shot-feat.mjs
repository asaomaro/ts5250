// 実ブラウザ(web-ui)で実機へ接続し、FEATPGM の 3 画面を SO/SI 表示 ON で撮る。
// 前提: npm run build 済み。実行: node --env-file=.env scripts/shot-feat.mjs
import { readFileSync, writeFileSync } from "node:fs";
import { serve } from "@hono/node-server";
import { WebSocketServer } from "ws";
import { buildApp, SessionManager, ServerConfigStore, PersonalConfigStore, ConfigResolver } from "@ts5250/server";
import { SecretCrypto } from "../packages/server/dist/secret-crypto.js";
import { chromium } from "playwright";

const log = (s) => process.stderr.write(s + "\n");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const OUT = "/tmp/claude-1000/-workspaces-as400-web-emulator/cff7c584-0ab5-4be3-b08e-bc65bf027295/scratchpad";
const PORT = 3473;

// connections.json をそのまま使う（DEV1=既存装置。ユニーク名は QAUTOVRT 上限に当たるため再利用）
const cfg = JSON.parse(readFileSync("connections.json", "utf8"));
const tmpCfg = `${OUT}/conn-feat.json`;
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

  // サインオン（サインオン画面のときだけ）
  if (await has("サインオン") || await has("ユーザー")) {
    const inputs = page.locator("input.grid-input");
    await inputs.nth(0).pressSequentially("USER", { delay: 45 });
    await sleep(120);
    await inputs.nth(1).pressSequentially("PASSWORD", { delay: 45 });
    await sleep(200);
    await clickEnter();
  }
  // 回復(90)・情報画面(Enter) を捌いてメニューへ
  for (let i = 0; i < 8; i++) {
    await sleep(1200);
    if (await has("メインメニュー")) break;
    if (await has("対話式ジョブの回復")) { await type("90"); await clickEnter(); }
    else await clickEnter();
  }
  log("menu reached: " + (await has("メインメニュー")));

  // SO/SI 表示を ON にする
  const sosi = page.locator('button:has-text("SO/SI")').first();
  if (await sosi.count()) { const pressed = await sosi.getAttribute("aria-pressed"); if (pressed !== "true") await sosi.click(); log("SO/SI aria-pressed=" + await sosi.getAttribute("aria-pressed")); }

  // ADDLIBLE → CALL FEATPGM
  await type("ADDLIBLE TESTLIB"); await clickEnter(); await sleep(1200);
  await type("CALL TESTLIB/FEATPGM"); await clickEnter(); await sleep(1500);
  await shot("feat-1-edit.png");         // SCRN1 EDTCDE/EDTWRD
  await clickEnter(); await sleep(1400);
  await shot("feat-2-color.png");        // SCRN2 color/bg/dspatr
  await clickEnter(); await sleep(1400);
  await shot("feat-3-cntfld-dbcs.png");  // SCRN3 CNTFLD/DBCS
  await clickEnter(); await sleep(800);
} catch (e) {
  log("SHOT ERROR: " + e.message);
  await shot("feat-error.png").catch(() => {});
} finally {
  await browser.close();
  server.close();
}
