// 実機検証（ブラウザ）: **WDSF の中身の読み方（選択肢の flag3・スクロール・バー付きの選択欄・0x59 のフラグ）**（`20260928-wdsf-behaviour`）。
//
// ACS のコア（`scripts/acs-probe/wdsf-behaviour.txt`。DSM の WDSFBEH）: W1 flag3 に 0x80 の無い選択肢は無い（AAA・CCC）、W2 スクロール・バー付きの選択のリストは 8 バイト後から（DDD・EEE）、
// W3 普通の窓にフラグ 0x40 の 0x59 では窓が残る（上へ 3 回で窓の中の 10,14 へ回り込む）、W4 フラグ 0x00 では窓が外れる（4,14）。同じ画面を当 PJ のブラウザで比べる。
//
// 前提:
//   npm run build && npm run build -w @ts5250/web-ui
//   DSCMD_LIB=<AS400_LIB> node --env-file=.env --env-file=.env.verify scripts/build-dscmd.mjs
// 実行: node --env-file=.env --env-file=.env.verify scripts/verify-browser-wdsf-behaviour.mjs
// **終わったら DLTPGM と IFS の /tmp/dscmd.c・/tmp/dscmd.log を消す**。
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { serve } from "@hono/node-server";
import { WebSocketServer } from "ws";
import { buildApp, SessionManager, ServerConfigStore, PersonalConfigStore, ConfigResolver } from "@ts5250/server";
import { SecretCrypto } from "../packages/server/dist/secret-crypto.js";
import { chromium } from "playwright";

const log = (s) => process.stderr.write(s + "\n");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const PORT = 3496;
const LIB = (process.env.AS400_LIB ?? "TESTLIB").trim().split(/\s+/)[0];
const TMP = "/tmp/as400-verify-wdsf-behaviour";
mkdirSync(TMP, { recursive: true });

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

/** 欄 i の view の位置 v へキャレットを置く（クリック相当。単体テストと同じ手順） */
async function at(i, v) {
  await inputs().nth(i).click();
  await inputs().nth(i).evaluate((el, pos) => {
    el.setSelectionRange(pos, pos);
    el.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  }, v);
  await sleep(120);
}
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
      if (process.env.WDSF_BEH_DEBUG_DIR) log(`  signon: inputs=${await inputs().count()} userLen=${(await inputs().nth(0).inputValue()).trim().length} pwLen=${(await inputs().nth(1).inputValue()).trim().length}`);
      await page.keyboard.press("Enter");
    } else await page.keyboard.press("Enter");
  }
  await runCmd(`CALL ${LIB}/DSCMD PARM('WDSFBEH')`);
  /** ステータスバーのカーソル位置（`03/010` の形） */
  const cursorText = async () => ((await page.locator("body").innerText()).match(/\b(\d\d)\/(\d\d\d)\b/) ?? []).slice(1).map(Number).join(",");
  const choices = () => page.evaluate(() => [...document.querySelectorAll(".gui-choice-text")].map((e) => e.textContent?.trim() ?? ""));
  const enterFrom = async (i) => {
    await inputs().nth(i).click();
    await page.keyboard.press("Enter");
    await sleep(2500);
  };
  // W1・W2: 選択肢の文字
  await page.waitForFunction(() => document.querySelectorAll(".gui-choice-text").length > 0, { timeout: 20000 });
  await sleep(800);
  let got = await choices();
  check(JSON.stringify(got) === JSON.stringify(["AAA", "CCC"]), `W1 選択肢 ${JSON.stringify(got)}（ACS: AAA・CCC——flag3 に 0x80 の無い BBB は無い）`);
  await enterFrom(0);
  got = await choices();
  check(JSON.stringify(got) === JSON.stringify(["DDD", "EEE"]), `W2 選択肢 ${JSON.stringify(got)}（ACS: DDD・EEE——スクロール・バー付きは 8 バイト後から）`);
  await enterFrom(0);
  // W3・W4: 窓の中の欄から上へ 3 回（窓が残っていれば窓の中に留まる）
  for (const [round, removed] of [["W3", false], ["W4", true]]) {
    await sleep(800);
    await at(0, 0); // 欄の先頭 7,14（ACS の probe の setcursor 7,14 と同じ）
    for (let i = 0; i < 3; i++) { await page.keyboard.press("ArrowUp"); await sleep(120); }
    await sleep(300);
    const c = await cursorText();
    const want = removed ? "4,14" : "10,14";
    check(c === want, `${round} 上へ 3 回でカーソル ${c}（ACS: ${want}——${removed ? "窓が外れた" : "窓が残り、窓の中で回り込む"}）`);
    await enterFrom(0);
  }
  await sleep(1000);
  await runCmd("SIGNOFF");
  await sleep(1500);
} catch (e) {
  // どの画面で止まったかを残す（利用者の画面の文字なのでリポジトリの外へ）
  const out = process.env.WDSF_BEH_DEBUG_DIR;
  if (out) {
    writeFileSync(`${out}/wdsf-behaviour-fail.txt`, await page.locator("body").innerText().catch(() => ""));
    await page.screenshot({ path: `${out}/wdsf-behaviour-fail.png` }).catch(() => {});
  }
  throw e;
} finally {
  await browser.close();
  server.close?.();
}

log(`RESULT: pass=${pass} fail=${fail}`);
process.exit(fail > 0 ? 1 : 0);
