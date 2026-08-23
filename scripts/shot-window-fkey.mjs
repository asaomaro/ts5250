// 実機の窓画面（TESTLIB/GRIDCL7 = GRIDTST5）で F3 ボタンを押し、
// 応答なしでタイムアウトしないこと＋エラー行にメッセージが出ることを Web UI で確かめる。
//   AS400_USER=... AS400_PASSWORD=... node --env-file=.env --env-file=.env.verify scripts/shot-window-fkey.mjs
import { readFileSync, writeFileSync } from "node:fs";
import { serve } from "@hono/node-server";
import { WebSocketServer } from "ws";
import { buildApp, SessionManager, ServerConfigStore, PersonalConfigStore, ConfigResolver } from "@ts5250/server";
import { SecretCrypto } from "../packages/server/dist/secret-crypto.js";
import { chromium } from "playwright";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (s) => process.stderr.write(s + "\n");
const OUT = process.env.SHOT_OUT ?? "/tmp";
const PORT = 3492;
const PGM = process.env.SHOT_PGM ?? "GRIDCL7";

const cfg = JSON.parse(readFileSync("connections.json", "utf8"));
writeFileSync(`${OUT}/conn-wfkey.json`, JSON.stringify(cfg));
const crypto = SecretCrypto.fromEnv();
const resolver = new ConfigResolver(
  ServerConfigStore.fromFile(`${OUT}/conn-wfkey.json`, crypto),
  new PersonalConfigStore({ systems: [], sessions: [] }, crypto)
);
const app = buildApp({ sessions: new SessionManager(), resolver, version: "shot", webRoot: "packages/web-ui/dist" });
const wss = new WebSocketServer({ noServer: true });
serve({ fetch: app.fetch, port: PORT, websocket: { server: wss } });
await sleep(600);

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1400, height: 820 }, deviceScaleFactor: 2 });
try {
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

  await page.keyboard.type(`CALL TESTLIB/${PGM}`);
  await page.keyboard.press("Enter");
  await sleep(3000);
  await page.locator(".pane").screenshot({ path: `${OUT}/wfkey-before.png` });

  // 画面の F3 ボタンを押す（キーボードの F3 はブラウザに食われるため、ボタンをクリックする）
  const t0 = Date.now();
  await page.click(".fk:has-text('F3')");
  await sleep(2500);
  const ms = Date.now() - t0;
  await page.locator(".pane").screenshot({ path: `${OUT}/wfkey-after.png` });
  const status = await page.locator(".statusbar, .status").first().innerText().catch(() => "(取得不可)");
  log(`F3 後 ${ms}ms / ステータス: ${status.replace(/\n/g, " | ")}`);

  // 応答待ちのまま固まっていないか（入力できるか）で判定する
  const locked = await page.locator(".pane").innerText().then((t) => t.includes("応答待ち"));
  log(locked ? "NG: 応答待ちのまま" : "OK: 入力可能に戻っている");
  log(`撮影: ${OUT}/wfkey-before.png / ${OUT}/wfkey-after.png`);
} finally {
  await browser.close();
  process.exit(0);
}
