// **実ブラウザ**で 3270 の F キーが効くことを確かめる（実機 IBM i）。
//
// 以前はここで「機能キーは使用できません。」が出ていた。IBM i の F キーは
// `PA1` ＋ `PFn` で、サーバーがそう送るようになったかを画面から見る。
//
// 前提: npm run build && npm run build -w @ts5250/web-ui
// 実行: node --env-file=.env scripts/verify-browser-3270-keys.mjs
import { mkdirSync, rmSync } from "node:fs";
import { serve } from "@hono/node-server";
import { WebSocketServer } from "ws";
import { buildApp, SessionManager, ServerConfigStore, PersonalConfigStore, ConfigResolver } from "@ts5250/server";
import { chromium } from "playwright";

const host = process.env.AS400_HOST;
const user = process.env.AS400_USER;
const password = process.env.AS400_PASSWORD;
if (!host || !user || !password) { process.stderr.write("環境変数が足りません\n"); process.exit(2); }

const PORT = 3496;
const SHOTS = "/tmp/as400-3270-keys/shots";
rmSync("/tmp/as400-3270-keys", { recursive: true, force: true });
mkdirSync(SHOTS, { recursive: true });
const log = (s) => process.stdout.write(s + "\n");
const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok });
  log(`${ok ? "OK  " : "NG  "} ${name}${detail ? ` — ${detail}` : ""}`);
};

const sys = { id: "sys1", name: "実機", host, signon: { user, passwordEnv: "AS400_PASSWORD" }, ccsid: 930 };
const ses = { id: "t1", name: "TEST-3270", system: "sys1", sessionType: "display", terminal: "3270", model3270: 2 };
const resolver = new ConfigResolver(
  new ServerConfigStore({ systems: [], sessions: [] }),
  new PersonalConfigStore({ systems: [sys], sessions: [ses] })
);
const app = buildApp({ sessions: new SessionManager(), resolver, version: "keys", webRoot: "packages/web-ui/dist" });
const wss = new WebSocketServer({ noServer: true });
const http = serve({ fetch: app.fetch, port: PORT, websocket: { server: wss } });
await new Promise((r) => setTimeout(r, 600));

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1400, height: 800 } });
page.on("pageerror", (e) => log(`PAGEERR ${e.message}`));
const shot = (n) => page.screenshot({ path: `${SHOTS}/${n}.png`, fullPage: true });
/**
 * 画面の文字。**`innerText` では見えない**——3270 の各桁は `<input>` の値で、
 * innerText に載らない（この落とし穴は前にも踏んだ）。値も集める。
 */
const body = () =>
  page.evaluate(() => {
    const root = document.body;
    const vals = [...root.querySelectorAll("input")].map((i) => i.value).join(" ");
    return `${root.innerText}\n${vals}`;
  });

try {
  await page.goto(`http://localhost:${PORT}/`);
  const pick = page.locator(".card", { hasText: "実機" }).locator("button", { hasText: "選択" });
  if ((await pick.count()) > 0) await pick.first().click();
  await page.locator(".card", { hasText: "TEST-3270" }).first().locator("button", { hasText: "接続" }).click();
  await page.waitForTimeout(7000);
  await shot("01-signon");

  await page.keyboard.type(user);
  await page.keyboard.press("Tab");
  await page.keyboard.type(password);
  await page.keyboard.press("Enter");
  await page.waitForTimeout(6000);
  await page.keyboard.press("Enter");          // サインオン情報 → メニュー
  await page.waitForTimeout(6000);
  await shot("02-menu");
  check("メインメニューに着く", (await body()).includes("メインメニュー"), "");

  // コマンドを打って F4（プロンプト）
  await page.keyboard.type("WRKACTJOB");
  await page.keyboard.press("F4");
  await page.waitForTimeout(7000);
  await shot("03-after-F4");
  const after = await body();
  check("**F4（プロンプト）が効く**", after.includes("活動ジョブ処理"), after.slice(0, 80).replace(/\s+/gu, " "));
  check("**「機能キーは使用できません」が出ない**", !after.includes("使用できません"), "");

  // F12 で戻る
  await page.keyboard.press("F12");
  await page.waitForTimeout(6000);
  await shot("04-after-F12");
  check("**F12（取り消し）が効く**", (await body()).includes("メインメニュー"), "");
} catch (e) {
  check("スクリプトが最後まで走る", false, String(e?.stack ?? e));
  await shot("99-crash");
} finally {
  await browser.close();
  http.close();
  wss.close();
}

const failed = results.filter((r) => !r.ok);
log(`\n${results.length - failed.length}/${results.length} 成功（画像: ${SHOTS}）`);
process.exit(failed.length > 0 ? 1 : 0);
