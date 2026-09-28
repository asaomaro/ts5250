// 実機検証（ブラウザ）: **全角の状態の E・J の欄のカーソルの桁と End が ACS と同じか**（`20260928-either-empty-view`）。
//
// ACS のコア（`scripts/acs-probe/je-field-end.txt`。DSM の JEEDIT）で測った End の行き先 6 通りを、同じ手順でブラウザの当 PJ に当て、
// 画面のカーソルの表示（行/桁）を ACS の値と比べる。最後に Enter を押し、ホストが受け取った READ MDT（/tmp/dscmd.log の `[J1]`）も ACS と比べる。
// 空にした全角の E に打ったときの桁（ACS `scripts/acs-probe/either-empty-type.txt`: い の後のカーソルは SO の次の次の字の後ろ）も見る。
//
// 前提:
//   npm run build && npm run build -w @ts5250/web-ui
//   DSCMD_LIB=<AS400_LIB> node --env-file=.env --env-file=.env.verify scripts/build-dscmd.mjs
// 実行: node --env-file=.env --env-file=.env.verify scripts/verify-browser-either-empty-view.mjs
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
const PORT = 3497;
const LIB = (process.env.AS400_LIB ?? "TESTLIB").trim().split(/\s+/)[0];
const TMP = "/tmp/as400-verify-either-empty-view";
mkdirSync(TMP, { recursive: true });

/** ACS のコアが送ったバイト列（`scripts/acs-probe/je-field-end.txt` の 2026-09-28 の実測。End は MDT を立てないので、変えた 2 欄だけ） */
const ACS_J1 = "11090a0e448140404040404040400f110d0a0e";

// 手順（欄の番号 0〜7、`at` は入力欄の view の位置——J・全角の E は SO＝0・最初の字＝1）と、その後の ACS のカーソル
const STEPS = [
  ["e1 J `あい`＋全角空白の End", [[1, "at", 1], [1, "key", "End"]], "5,15"],
  ["e2 空の J の End", [[0, "at", 1], [0, "key", "End"]], "3,11"],
  ["e3 compact の E の End（SI の後ろ）", [[4, "at", 1], [4, "key", "End"]], "11,14"],
  ["e4 中身の中から消した E（open）の End", [[5, "at", 2], [5, "key", "Alt+Delete"], [5, "at", 1], [5, "key", "End"]], "13,13"],
  ["e5 半角から切り替えた E（full）の End", [[3, "at", 0], [3, "ime", "あ"], [3, "at", 1], [3, "key", "End"]], "9,13"],
  ["e6 空にした全角の E の End（SO の次）", [[5, "at", 1], [5, "key", "Alt+Delete"], [5, "at", 5], [5, "key", "End"]], "13,11"]
];

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
const cdp = await page.context().newCDPSession(page);

/** 欄 i の view の位置 v へキャレットを置く（クリック相当。単体テストと同じ手順） */
async function at(i, v) {
  await inputs().nth(i).click();
  await inputs().nth(i).evaluate((el, pos) => {
    el.setSelectionRange(pos, pos);
    el.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  }, v);
  await sleep(120);
}
async function ime(text) {
  await cdp.send("Input.imeSetComposition", { text, selectionStart: text.length, selectionEnd: text.length });
  await cdp.send("Input.insertText", { text });
  await sleep(250);
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
      if (process.env.EMPTY_VIEW_DEBUG_DIR) log(`  signon: inputs=${await inputs().count()} userLen=${(await inputs().nth(0).inputValue()).trim().length} pwLen=${(await inputs().nth(1).inputValue()).trim().length}`);
      await page.keyboard.press("Enter");
    } else await page.keyboard.press("Enter");
  }
  await runCmd(`CALL ${LIB}/DSCMD PARM('JEEDIT')`);
  await page.waitForFunction(() => document.querySelectorAll("input.grid-input:not([readonly])").length >= 8, { timeout: 20000 });
  await sleep(800);
  const cursorText = async () => ((await page.locator("body").innerText()).match(/\b(\d\d)\/(\d\d\d)\b/) ?? []).slice(1).map(Number).join(",");
  for (const [label, steps, want] of STEPS) {
    for (const [i, op, arg] of steps) {
      if (op === "at") await at(i, arg);
      else if (op === "ime") await ime(arg);
      else await page.keyboard.press(arg);
      await sleep(120);
    }
    const got = await cursorText();
    check(got === want, `${label}: カーソル ${got}（ACS ${want}）`);
  }
  await page.keyboard.press("Enter");
  await sleep(3000);
  // 残りの 2 巡は何もせずに送る（JEEDIT は READ MDT を 3 回待つ）
  for (let k = 0; k < 2; k++) {
    await inputs().nth(0).click();
    await page.keyboard.press("Enter");
    await sleep(2500);
  }
  await sleep(1000);
  await runCmd("SIGNOFF");
  await sleep(1500);
} catch (e) {
  // どの画面で止まったかを残す（利用者の画面の文字なのでリポジトリの外へ）
  const out = process.env.EMPTY_VIEW_DEBUG_DIR;
  if (out) {
    writeFileSync(`${out}/either-empty-view-fail.txt`, await page.locator("body").innerText().catch(() => ""));
    await page.screenshot({ path: `${out}/either-empty-view-fail.png` }).catch(() => {});
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
const got = text.match(/^\[J1\] QsnRtvFldDta len=\d+ hex=([0-9a-f]*)/m)?.[1];
check(got === ACS_J1, `J1 のバイト列が ACS と同じ${got === ACS_J1 ? "" : `\n    当 PJ: ${got}\n    ACS:   ${ACS_J1}`}`);
log(`RESULT: pass=${pass} fail=${fail}`);
process.exit(fail > 0 ? 1 : 0);
