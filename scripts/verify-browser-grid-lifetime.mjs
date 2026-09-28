// 実機検証（ブラウザ）: **WDSF 0x60 の罫線の寿命（窓・0x5F・0x61・CLEAR UNIT）**（`20260928-grid-window-hole`）。
//
// ACS のコア（`scripts/acs-probe/grid-lifetime.txt`。DSM の GRIDLIFE）で罫線の面（`ECLPS.GridPlane`）を読んだ結果を、当 PJ の画面の罫線（`.grid-line` の線分）で比べる。
// 箱は 5,5 から 40 桁×8 行（境界で上 4・下 12・左 4・右 44）。ACS: G1〜G3・G5・G7 は 95 桁（箱のまま）、G4 は窓（5,10・幅 20・深さ 5）の範囲の上辺 26 桁が消え、
// G6 は 0x61（5,5 から幅 10・深さ 1）の 10 桁（上辺と左辺の 5 行目）が消えた。
//
// 前提:
//   npm run build && npm run build -w @ts5250/web-ui
//   DSCMD_LIB=<AS400_LIB> node --env-file=.env --env-file=.env.verify scripts/build-dscmd.mjs
// 実行: node --env-file=.env --env-file=.env.verify scripts/verify-browser-grid-lifetime.mjs
// **終わったら DLTPGM と IFS の /tmp/dscmd.c・/tmp/dscmd.log を消す**。
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { serve } from "@hono/node-server";
import { WebSocketServer } from "ws";
import { buildApp, SessionManager, ServerConfigStore, PersonalConfigStore, ConfigResolver } from "@ts5250/server";
import { SecretCrypto } from "../packages/server/dist/secret-crypto.js";
import { chromium } from "playwright";

const log = (s) => process.stderr.write(s + "\n");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const PORT = 3495;
const LIB = (process.env.AS400_LIB ?? "TESTLIB").trim().split(/\s+/)[0];
const TMP = "/tmp/as400-verify-grid-lifetime";
mkdirSync(TMP, { recursive: true });

/** 箱のままの 4 本（`ScreenGrid.vue` の `gridSegments` の書式: 横は top・left・width、縦は left・top・height。単位は em / ch） */
const BOX = ["h top=5 left=4 w=40", "h top=15 left=4 w=40", "v left=4 top=5 h=10", "v left=44 top=5 h=10"];
const EXPECT = {
  G1: BOX,
  G2: BOX,
  G3: BOX,
  // 窓（5,10・幅 20＋6・深さ 5＋2）: 上辺の 10〜35 桁（境界 9〜35）が抜ける
  G4: ["h top=5 left=4 w=5", "h top=5 left=35 w=9", "h top=15 left=4 w=40", "v left=4 top=5 h=10", "v left=44 top=5 h=10"],
  G5: BOX,
  // 0x61（5,5・幅 10・深さ 1）: 上辺の 5〜14 桁と、左辺の 5 行目が抜ける
  G6: ["h top=5 left=14 w=30", "h top=15 left=4 w=40", "v left=4 top=6.25 h=8.75", "v left=44 top=5 h=10"],
  G7: BOX
};

const cfg = JSON.parse(readFileSync("profiles.local.json", "utf8"));
const tmpCfg = `${TMP}/profiles.json`;
writeFileSync(tmpCfg, JSON.stringify(cfg));
const crypto = SecretCrypto.fromEnv();
const resolver = new ConfigResolver(ServerConfigStore.fromFile(tmpCfg, crypto), new PersonalConfigStore({ systems: [], sessions: [] }, crypto));
const app = buildApp({ sessions: new SessionManager(), resolver, version: "verify", webRoot: "packages/web-ui/dist" });
const wss = new WebSocketServer({ noServer: true });
const server = serve({ fetch: app.fetch, port: PORT, websocket: { server: wss } });
await sleep(600);

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1500, height: 820 } });
page.on("pageerror", (e) => log("PAGEERR " + e.message));
await page.addInitScript(() => {
  localStorage.setItem("as400.keybindings", JSON.stringify({ "alt+Delete": "local:erase-eof" }));
});
let pass = 0, fail = 0;
const check = (c, m) => { if (c) { pass++; log(`  PASS ${m}`); } else { fail++; log(`  FAIL ${m}`); } };
const inputs = () => page.locator("input.grid-input:not([readonly])");

async function runCmd(text) {
  const el = inputs().last();
  await el.click();
  await page.keyboard.press("Home");
  await page.keyboard.type(text, { delay: 15 });
  await page.keyboard.press("Enter");
}

try {
  // 接続（システムのカードで「選択」→ セッション設定のカードで「接続」。`verify-browser-idle.mjs` と同じ手順）
  await page.goto(`http://localhost:${PORT}/`);
  await page.waitForSelector(".launcher", { timeout: 20000 });
  await page.click(`.card:has-text('${process.env.AS400_SYSTEM ?? "AS400"}') >> button:has-text('選択')`);
  const name = process.env.AS400_SESSION ?? "AS400";
  await page.waitForSelector(`.card:has-text('${name}')`, { timeout: 10000 });
  await page.click(`.card:has-text('${name}') >> button:has-text('接続')`);
  await page.waitForFunction(() => /サインオン|ユーザー|回復|メインメニュー/.test(document.body.innerText), { timeout: 25000 });
  // メインメニューまで（サインオン画面なら打つ。回復の画面は 90 で抜ける）
  for (let i = 0; i < 20; i++) {
    await sleep(1200);
    const body = await page.locator("body").innerText();
    if (body.includes("メインメニュー")) break;
    if (body.includes("対話式ジョブの回復")) {
      await runCmd("90");
    } else if (body.includes("サイン") && body.includes("ユーザー")) {
      await inputs().nth(0).click();
      await page.keyboard.press("Home");
      await page.keyboard.type(process.env.AS400_USER, { delay: 20 });
      await page.keyboard.press("Tab"); // パスワードの欄（伏せ字の欄は入力欄の一覧に値が見えないので、Tab で移る）
      await page.keyboard.type(process.env.AS400_PASSWORD, { delay: 20 });
      if (process.env.GRID_DEBUG_DIR) log(`  signon: inputs=${await inputs().count()} userLen=${(await inputs().nth(0).inputValue()).trim().length} pwLen=${(await inputs().nth(1).inputValue()).trim().length}`);
      await page.keyboard.press("Enter");
    } else await page.keyboard.press("Enter");
  }
  await runCmd(`CALL ${LIB}/DSCMD PARM('GRIDLIFE')`);
  for (const [round, want] of Object.entries(EXPECT)) {
    await page.waitForFunction(() => document.querySelectorAll("input.grid-input:not([readonly])").length === 1, { timeout: 20000 });
    await sleep(1200);
    const got = await page.evaluate(() =>
      [...document.querySelectorAll(".grid-line")].map((el) => {
        const st = el.getAttribute("style") ?? "";
        const n = (k) => st.match(new RegExp(`${k}: ([\\d.]+)`))?.[1];
        return el.classList.contains("grid-h") ? `h top=${n("top")} left=${n("left")} w=${n("width")}` : `v left=${n("left")} top=${n("top")} h=${n("height")}`;
      }).sort()
    );
    const w = [...want].sort();
    check(JSON.stringify(got) === JSON.stringify(w), `${round}: ${got.length} 本${JSON.stringify(got) === JSON.stringify(w) ? "" : `\n    当 PJ: ${JSON.stringify(got)}\n    期待:  ${JSON.stringify(w)}`}`);
    await inputs().nth(0).click();
    await page.keyboard.press("Enter");
    await sleep(2500);
  }
  await sleep(1000);
  await runCmd("SIGNOFF");
  await sleep(1500);
} catch (e) {
  // どの画面で止まったかを残す（利用者の画面の文字なのでリポジトリの外へ）
  const out = process.env.GRID_DEBUG_DIR;
  if (out) {
    writeFileSync(`${out}/grid-lifetime-fail.txt`, await page.locator("body").innerText().catch(() => ""));
    await page.screenshot({ path: `${out}/grid-lifetime-fail.png` }).catch(() => {});
  }
  throw e;
} finally {
  await browser.close();
  server.close?.();
}

log(`RESULT: pass=${pass} fail=${fail}`);
process.exit(fail > 0 ? 1 : 0);
