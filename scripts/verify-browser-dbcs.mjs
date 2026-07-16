// 実ブラウザでの DBCS 入力ラウンドトリップ E2E。build 済み web-ui を server で配信し、
// Playwright で DBCS プロファイル（CCSID 1399）へ接続 → INPPGM を CALL →
// SBCS 欄に "HELLO"、DBCS 欄に "日本語"（IME 合成イベントで入力）→ Enter →
// ホストのエコー欄に返るかを検証する。
//   ※ DBCS は CCSID 1399 セッションが必須（既定 pub400=CCSID 37 では不可）。
//   ※ 事前に build-attrtest.mjs で INPTST/INPPGM を作成しておくこと。
// 前提: npm run build 済み。profiles.local.json に CCSID 1399 のプロファイルがあること。
// 実行: node --env-file=.env scripts/verify-browser-dbcs.mjs
import { serve } from "@hono/node-server";
import { WebSocketServer } from "ws";
import { buildApp, SessionManager, ProfileStore } from "@as400web/server";
import { chromium } from "playwright";

const log = (s) => process.stderr.write(s + "\n");
const LIB = process.env.PUB400_LIB ?? "MYLIB";
const PORT = 3467;

const sessions = new SessionManager();
const profiles = ProfileStore.fromFile("profiles.local.json");
const app = buildApp({ sessions, profiles, version: "test", webRoot: "packages/web-ui/dist" });
const wss = new WebSocketServer({ noServer: true });
const server = serve({ fetch: app.fetch, port: PORT, websocket: { server: wss } });
await new Promise((r) => setTimeout(r, 500));

// CCSID 1399 の DBCS プロファイル名を /api/profiles から特定
const pubList = await (await fetch(`http://localhost:${PORT}/api/profiles`)).json();
const jp = pubList.profiles.find((p) => p.ccsid === 1399);
if (!jp) {
  log("NG — CCSID 1399 のプロファイルが profiles.local.json にありません（DBCS には 1399 が必須）。");
  server.close?.(); process.exit(1);
}
log(`DBCS プロファイル: ${jp.name} (ccsid ${jp.ccsid})`);

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1100, height: 700 } });
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
let ok = true;
try {
  await page.goto(`http://localhost:${PORT}/`);
  await page.locator("button.card", { hasText: jp.name }).first().click();
  await page.waitForFunction(() => document.querySelector(".grid")?.textContent?.includes("Main Menu"), { timeout: 20000 });
  log("接続・自動サインオン OK");

  // INPPGM を CALL
  const cmd = page.locator("input.grid-input").first();
  await cmd.click();
  await page.keyboard.type(`CALL ${LIB}/INPPGM`);
  await page.keyboard.press("Enter");
  await page.waitForFunction(() => document.querySelector(".grid")?.textContent?.includes("INPUT TEST"), { timeout: 20000 });
  log("INPPGM 表示");

  const inputs = page.locator("input.grid-input:not([readonly])");
  ok = (await inputs.count()) === 2 && ok;

  // SBCS 入力
  await inputs.nth(0).click();
  await page.keyboard.type("HELLO");
  // DBCS 入力（IME 合成イベントを忠実に発火）
  const j = inputs.nth(1);
  await j.click();
  await j.evaluate((el, text) => {
    el.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
    el.value = text;
    el.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertCompositionText", data: text }));
    el.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true, data: text }));
  }, "日本語");
  const jval = (await j.inputValue()).replace(/\s+$/, "");
  log(`DBCS 欄の値: "${jval}"`);
  ok = jval === "日本語" && ok;

  await page.keyboard.press("Enter");
  await page.waitForTimeout(2500);
  const grid = await page.evaluate(() => document.querySelector(".grid").innerText);
  const echo = grid.split("\n").slice(5, 7).join(" ");
  log("エコー行: " + echo.replace(/\s+/g, " ").trim());
  const sbcsOk = /A ECHO:\s*HELLO/.test(grid);
  const dbcsOk = /J ECHO:\s*日本語/.test(grid);
  log(`${sbcsOk ? "PASS" : "FAIL"}  SBCS 入力がエコーされる (HELLO)`);
  log(`${dbcsOk ? "PASS" : "FAIL"}  DBCS(日本語) 入力がエコーされる`);
  ok = ok && sbcsOk && dbcsOk;

  if (errors.length) { ok = false; log("PAGE ERRORS: " + errors.join(" | ")); }
} catch (e) {
  ok = false; log("BROWSER E2E ERROR: " + e.message);
} finally {
  await browser.close();
  server.close?.();
}
log(ok ? "\nOK — ブラウザ（IME）での DBCS 入力ラウンドトリップに対応" : "\nNG");
process.exit(ok ? 0 : 1);
