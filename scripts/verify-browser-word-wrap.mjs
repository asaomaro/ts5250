// 実機検証（ブラウザ）: **語送りの欄（FCW 0x8680）の編集がホストへ ACS と同じバイト列で届くか**（台帳「語送り」。`20260930-word-wrap`）。
//
// ACS のコア（`scripts/acs-probe/word-wrap.txt`）で測った W1〜W8 を、同じ打鍵でブラウザの当 PJ に当て、
// ホストが受け取った欄のバイト列（DSM の WRAPFLD の /tmp/dscmd.log の `[W1]`〜`[W8]` の QsnRtvFldDta）を ACS の値と巡ごとに比べる。
// 欄は (5,70) から 30 桁（5 行目の 11 桁＋6 行目の頭から 19 桁）。W7 だけ READ MDT（途中の NUL が 40 になる）、ほかは READ MDT ALT。
//
// 前提:
//   npm run build && npm run build -w @ts5250/web-ui
//   DSCMD_LIB=<AS400_LIB> node --env-file=.env --env-file=.env.verify scripts/build-dscmd.mjs
// 実行: node --env-file=.env --env-file=.env.verify scripts/verify-browser-word-wrap.mjs
// **終わったら DLTPGM と IFS の /tmp/dscmd.c・/tmp/dscmd.log を消す**。
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { serve } from "@hono/node-server";
import { WebSocketServer } from "ws";
import { buildApp, SessionManager, ServerConfigStore, PersonalConfigStore, ConfigResolver } from "@ts5250/server";
import { SecretCrypto } from "../packages/server/dist/secret-crypto.js";
import { IfsConnection } from "@ts5250/hostserver";
import { codecForCcsid } from "@ts5250/ebcdic";
import { chromium } from "playwright";

const log = (s) => process.stderr.write(s + "\n");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const PORT = 3498;
const LIB = (process.env.AS400_LIB ?? "TESTLIB").trim().split(/\s+/)[0];
const TMP = "/tmp/as400-verify-word-wrap";
mkdirSync(TMP, { recursive: true });

/** ACS のコアが送ったバイト列（`scripts/acs-probe/word-wrap.txt` の 2026-09-30 の実測。QsnRtvFldDta） */
const ACS = {
  W1: "1105478181814082828282400000838383834084848484",
  W2: "11054796958540a3a69640000000a388998585408696a499408689a58540a289a7",
  W3: "1105478181828282824000000000838383834084848484",
  W4: "110547818181e7e7e7e740000000828282824083838383",
  W5: "110547818283848586878889919293949596979899a2a3a4a5a6a7a8a9",
  W6: "1105478181814082828282400000838383",
  W7: "1105478181814082828282404040838383834084848484",
  W8: "110547818181404082828282404040838383834084848484"
};
const TEXT = "aaa bbbb cccc dddd";
const ROUNDS = {
  W1: [["type", TEXT]],
  W2: [["type", "one two three four five six"]],
  W3: [["type", TEXT], ["at", 2], ["key", "Delete"], ["key", "Delete"]],
  W4: [["type", "aaa bbbb cccc"], ["at", 3], ["key", "Insert"], ["type", "XXXX"], ["key", "Insert"]],
  W5: [["type", "abcdefghijklmnopqrstuvwxyz"]],
  W6: [["type", TEXT], ...Array.from({ length: 6 }, () => ["key", "Backspace"])],
  W7: [["type", TEXT]],
  W8: [["type", "aaa  bbbb   cccc dddd"]]
};
const ROUND_NAMES = Object.keys(ROUNDS);

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
let pass = 0, fail = 0;
const check = (c, m) => { if (c) { pass++; log(`  PASS ${m}`); } else { fail++; log(`  FAIL ${m}`); } };
const inputs = () => page.locator("input.grid-input:not([readonly])");

/** 欄内の位置 v（1 行目の 11 桁の中）へキャレットを置く */
async function at(v) {
  await inputs().nth(0).click();
  await inputs().nth(0).evaluate((el, pos) => {
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
      if (process.env.WORD_WRAP_DEBUG_DIR) log(`  signon: inputs=${await inputs().count()} userLen=${(await inputs().nth(0).inputValue()).trim().length} pwLen=${(await inputs().nth(1).inputValue()).trim().length}`);
      await page.keyboard.press("Enter");
    } else await page.keyboard.press("Enter");
  }
  await runCmd(`CALL ${LIB}/DSCMD PARM('WRAPFLD')`);
  await page.waitForFunction(() => document.querySelectorAll("input.grid-input:not([readonly])").length >= 1, { timeout: 20000 });
  await sleep(800);
  for (const round of ROUND_NAMES) {
    await at(0);
    for (const [op, arg] of ROUNDS[round]) {
      if (op === "at") await at(arg);
      else if (op === "type") await page.keyboard.type(arg, { delay: 40 });
      else await page.keyboard.press(arg);
      await sleep(80);
    }
    await page.keyboard.press("Enter");
    await sleep(3000);
  }
  await sleep(1000);
  await runCmd("SIGNOFF");
  await sleep(1500);
} catch (e) {
  // どの画面で止まったかを残す（利用者の画面の文字なのでリポジトリの外へ）
  const out = process.env.WORD_WRAP_DEBUG_DIR;
  if (out) {
    writeFileSync(`${out}/word-wrap-fail.txt`, await page.locator("body").innerText().catch(() => ""));
    await page.screenshot({ path: `${out}/word-wrap-fail.png` }).catch(() => {});
  }
  throw e;
} finally {
  await browser.close();
  server.close?.();
}

const ifs = await IfsConnection.connect({ host: process.env.AS400_HOST, user: process.env.AS400_USER, password: process.env.AS400_PASSWORD });
const t = await ifs.readTextFile("/tmp/dscmd.log");
const bytes = t?.data ?? t;
const text = typeof bytes === "string" ? bytes : codecForCcsid(t?.ccsid ?? 37).decode(Uint8Array.from(Object.values(bytes)));
ifs.close?.();
for (const round of ROUND_NAMES) {
  const got = text.match(new RegExp(`^\\[${round}\\] QsnRtvFldDta len=\\d+ hex=([0-9a-f]*)`, "m"))?.[1];
  check(got === ACS[round], `${round} のバイト列が ACS と同じ${got === ACS[round] ? "" : `\n    当 PJ: ${got}\n    ACS:   ${ACS[round]}`}`);
}
log(`RESULT: pass=${pass} fail=${fail}`);
process.exit(fail > 0 ? 1 : 0);
