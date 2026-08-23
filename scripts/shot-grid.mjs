// 実機の罫線・窓の画面を Web UI に描かせて画像に落とす。ACS の同じ画面と見比べる道具。
//
// 画面は scripts/build-gridtest3.mjs が実機に作る CL を指定する:
//   GRIDCL2 … 箱 2 つ（HRZVRT の内部罫線）＋ WDWBORDER((*COLOR PNK))
//   GRIDCL3 … 線種ちがいの箱・横罫だけ／縦罫だけの箱 ＋ 反転の空白で描く枠
//   GRIDCL4 … 単独罫線の繰り返し ＋ 枠文字を指定した窓 ＋ 見出し
//   GRIDCL5 … 背景の上の窓（窓の中に背景が透けないか）
//   GRIDCL6 … 枠指定の無い窓（表示設定の枠と実際の窓が重なるか）
//   GRIDCL7 … 窓を閉じたときにホストが何を送ってくるか
//
// 資格情報は環境変数からのみ受け取る（引数はプロセス一覧に見えるため）。
//   AS400_HOST=... AS400_USER=... AS400_PASSWORD=... \
//   SHOT_OUT=<出力先> SHOT_PGMS=GRIDCL3,GRIDCL4 node scripts/shot-grid.mjs
import { readFileSync, writeFileSync } from "node:fs";
import { serve } from "@hono/node-server";
import { WebSocketServer } from "ws";
import { buildApp, SessionManager, ServerConfigStore, PersonalConfigStore, ConfigResolver } from "@ts5250/server";
import { SecretCrypto } from "../packages/server/dist/secret-crypto.js";
import { chromium } from "playwright";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (s) => process.stderr.write(s + "\n");
const OUT = process.env.SHOT_OUT ?? "/tmp";
const PORT = 3491;
const cfg = JSON.parse(readFileSync("connections.json", "utf8"));
writeFileSync(`${OUT}/conn-grid.json`, JSON.stringify(cfg));
const crypto = SecretCrypto.fromEnv();
const resolver = new ConfigResolver(
  ServerConfigStore.fromFile(`${OUT}/conn-grid.json`, crypto),
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
  // サインオン・回復画面・メッセージを抜けてコマンド行へ
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
  for (const pgm of (process.env.SHOT_PGMS ?? "GRIDCL2").split(",")) {
    await page.keyboard.type(`CALL TESTLIB/${pgm}`);
    await page.keyboard.press("Enter");
    await sleep(3000);
    await page.locator(".pane").screenshot({ path: `${OUT}/grid-${pgm}.png` });
    log("撮影: " + OUT + "/grid-" + pgm + ".png");
    // 窓を閉じてコマンド行へ戻す
    for (let i = 0; i < 4; i++) {
      const t = await page.locator(".pane").innerText();
      if (t.includes("コマンドを入力")) break;
      await page.keyboard.press("Enter");
      await sleep(2500);
    }
  }
} finally {
  await browser.close();
  process.exit(0);
}
