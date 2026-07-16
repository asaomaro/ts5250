// 実ブラウザでの入力 E2E: DBCS(日本語)ラウンドトリップ＋フィールド型ルール（NUM/A/O/J）。build 済み web-ui を server で配信し、
// Playwright で DBCS プロファイル（CCSID 1399）へ接続 → INPPGM(NUM/A/O/J) を CALL →
// O/J へ日本語（実 IME＝CDP）を入力→Enter→エコー往復、さらにフィールド型ルール
// （J は SBCS 不可・A は DBCS 不可・NUM は英字不可）をブラウザ実経路で検証する。
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
  await page.waitForFunction(() => document.querySelector(".grid")?.textContent?.includes("FIELD TYPE TEST"), { timeout: 20000 });
  log("INPPGM（NUM/A/O/J）表示");

  const inputs = page.locator("input.grid-input:not([readonly])");
  ok = (await inputs.count()) === 4 && ok;
  const num = inputs.nth(0), a = inputs.nth(1), o = inputs.nth(2), j = inputs.nth(3); // 行順=NUM/A/O/J
  const cdp = await page.context().newCDPSession(page);
  const val = async (loc) => (await loc.inputValue()).replace(/\s+/g, "");
  const rule = (name, cond, d = "") => { log(`${cond ? "PASS" : "FAIL"}  ${name}${d ? "  — " + d : ""}`); ok = ok && cond; };
  // 実 IME（CDP）で欄先頭から合成→確定
  const ime = async (loc, text) => {
    await loc.click(); await page.keyboard.press("Home");
    await cdp.send("Input.imeSetComposition", { text, selectionStart: text.length, selectionEnd: text.length });
    await cdp.send("Input.insertText", { text });
    await page.waitForTimeout(250);
  };

  // DBCS 往復（新レイアウト: O=行5, J=行6）。NUM=初期値0/A=空のまま Enter して有効に送る
  await ime(o, "日本");
  await ime(j, "日本語");
  rule("J 欄に DBCS(日本語) が入る", (await val(j)) === "日本語", await val(j));
  await page.keyboard.press("Enter");
  await page.waitForTimeout(2500);
  const grid = await page.evaluate(() => document.querySelector(".grid").innerText);
  const lines = grid.split("\n");
  rule("O(open) 入力がエコーされる（日本）", /日本/.test(lines[4] ?? ""));
  rule("J(pure) 入力がエコーされる（日本語）", /日本語/.test(lines[5] ?? ""));

  // フィールド型の入力ルール（フロント検証・Enter 不要）
  await j.click(); await page.keyboard.press("End"); await page.keyboard.type("A"); // J に SBCS
  rule("J は SBCS を拒否（キー入力が入らない）", !/[A-Za-z]/.test(await val(j)), await val(j));
  await ime(a, "あ"); // A に DBCS(IME)
  rule("A は DBCS を拒否", (await val(a)) === "", await val(a));
  await num.click(); await page.keyboard.press("Home"); await page.keyboard.type("1A2"); // NUM に英字
  rule("NUM は英字を拒否（数字のみ）", !/[A-Za-z]/.test(await val(num)), await val(num));

  if (errors.length) { ok = false; log("PAGE ERRORS: " + errors.join(" | ")); }
} catch (e) {
  ok = false; log("BROWSER E2E ERROR: " + e.message);
} finally {
  await browser.close();
  server.close?.();
}
log(ok ? "\nOK — ブラウザ入力: DBCS 往復＋フィールド型ルール" : "\nNG");
process.exit(ok ? 0 : 1);
