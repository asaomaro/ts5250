// 実機検証（ブラウザ）: **E 欄の残り（伏せ字・Dup・挿入の余地）がホストへ ACS と同じバイト列で届くか**（台帳「E 欄の残り」）。
//
// ACS のコア（`scripts/acs-probe/either-remainder.txt`・`either-insert.txt`）で測った巡を、同じ打鍵でブラウザの当 PJ に当て、
// ホストが受け取った READ MDT ALT のバイト列（DSM の EITHERX・EITHERI の /tmp/dscmd.log の `[X1]`〜`[X3]`・`[I1]`）を ACS の値と巡ごとに比べる。
// 全角は実 IME（CDP の `Input.imeSetComposition`＋`insertText`）で打つ。操作員エラーは Control（Reset）で抜ける。
// DSM は実行のたびにログを作り直すので、モードごとに読む。
//
// 前提:
//   npm run build && npm run build -w @ts5250/web-ui
//   DSCMD_LIB=<AS400_LIB> node --env-file=.env --env-file=.env.verify scripts/build-dscmd.mjs
// 実行: node --env-file=.env --env-file=.env.verify scripts/verify-browser-either-remainder.mjs
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
const PORT = 3499;
const LIB = (process.env.AS400_LIB ?? "TESTLIB").trim().split(/\s+/)[0];
const TMP = "/tmp/as400-verify-either-remainder";
mkdirSync(TMP, { recursive: true });

/** ACS のコアが送ったバイト列（`scripts/acs-probe/either-remainder.txt`・`either-insert.txt` の 2026-09-30 の実測。QsnRtvFldDta） */
const ACS = {
  X1: "11030a0e448100000000000000000f11050ac1c2",
  X2: "11070a0e44811c1c1c1c1c1c1c1c0f11090a1c1c1c1c1c1c1c1c1c1c1c1c",
  X3: "",
  // EITHERI: 6 つの欄へ 1 件ずつ挿入。余地なし・型違いは値が変わらず、送られるのは最後の空の E だけ
  I1: "110d0a0e448100000000000000000f"
};
// 手順（欄の番号、`at` は入力欄の view の位置——SO＝0・最初の字＝1。全角も 1 字）
const ROUNDS = {
  X1: [
    [0, [["at", 0], ["ime", "あ"], ["type", "A"], ["key", "Control"]]], // 全角の後の半角は 0060 系のエラー（Reset で抜ける）
    [1, [["at", 0], ["type", "AB"], ["ime", "あ"], ["key", "Control"]]] // 半角の後の全角もエラー
  ],
  X2: [
    [2, [["at", 2], ["key", "Shift+Insert"]]],
    [3, [["at", 0], ["key", "Shift+Insert"]]]
  ],
  X3: [
    [4, [["at", 2], ["key", "Insert"], ["ime", "か"], ["key", "Control"], ["key", "Insert"]]],
    [5, [["at", 2], ["key", "Insert"], ["ime", "あ"], ["key", "Control"], ["key", "Insert"]]]
  ]
};
const ROUND_NAMES = Object.keys(ROUNDS);
const INSERT_STEPS = [
  [0, [["at", 2], ["key", "Insert"], ["ime", "か"], ["key", "Control"]]], // 余地なし（SI の分に最後の桁を取っておく）
  [1, [["at", 2], ["key", "Insert"], ["type", "A"], ["key", "Control"]]], // DBCS の中に半角
  [2, [["at", 5], ["key", "Insert"], ["type", "A"], ["key", "Control"]]], // 満杯の E の SI の桁に半角
  [3, [["at", 2], ["key", "Insert"], ["ime", "あ"], ["key", "Control"]]], // SBCS の E に全角（余地なし）
  [4, [["at", 2], ["key", "Insert"], ["ime", "あ"], ["key", "Control"]]], // SBCS の E に全角（余地あり。ACS は英数字でないと断る）
  [5, [["at", 0], ["key", "Insert"], ["ime", "あ"]]]
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

/** ホストのログ（DSM は実行のたびに作り直すので、モードごとに読む） */
async function readHostLog() {
  const ifs = await IfsConnection.connect({ host: process.env.AS400_HOST, user: process.env.AS400_USER, password: process.env.AS400_PASSWORD });
  const t = await ifs.readTextFile("/tmp/dscmd.log");
  const bytes = t?.data ?? t;
  const text = typeof bytes === "string" ? bytes : codecForCcsid(t?.ccsid ?? 37).decode(Uint8Array.from(Object.values(bytes)));
  ifs.close?.();
  return text;
}
const logs = {};

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
      if (process.env.EITHER_DEBUG_DIR) log(`  signon: inputs=${await inputs().count()} userLen=${(await inputs().nth(0).inputValue()).trim().length} pwLen=${(await inputs().nth(1).inputValue()).trim().length}`);
      await page.keyboard.press("Enter");
    } else await page.keyboard.press("Enter");
  }
  await runCmd(`CALL ${LIB}/DSCMD PARM('EITHERX')`);
  await page.waitForFunction(() => document.querySelectorAll("input.grid-input:not([readonly])").length >= 6, { timeout: 20000 });
  await sleep(800);
  for (const round of ROUND_NAMES) {
    for (const [i, steps] of ROUNDS[round]) {
      for (const [op, arg] of steps) {
        if (op === "at") await at(i, arg);
        else if (op === "type") await page.keyboard.type(arg, { delay: 30 });
        else if (op === "ime") await ime(arg);
        else await page.keyboard.press(arg);
        await sleep(80);
      }
    }
    await inputs().nth(0).click();
    await page.keyboard.press("Enter");
    await sleep(3000);
  }
  await sleep(1000);
  logs.X = await readHostLog();
  // 挿入の巡（EITHERI）
  await runCmd(`CALL ${LIB}/DSCMD PARM('EITHERI')`);
  await page.waitForFunction(() => document.querySelectorAll("input.grid-input:not([readonly])").length >= 6, { timeout: 20000 });
  await sleep(800);
  for (const [i, steps] of INSERT_STEPS) {
    for (const [op, arg] of steps) {
      if (op === "at") await at(i, arg);
      else if (op === "type") await page.keyboard.type(arg, { delay: 30 });
      else if (op === "ime") await ime(arg);
      else await page.keyboard.press(arg);
      await sleep(80);
    }
  }
  await inputs().nth(0).click();
  await page.keyboard.press("Enter");
  await sleep(3000);
  logs.I = await readHostLog();
  await runCmd("SIGNOFF");
  await sleep(1500);
} catch (e) {
  // どの画面で止まったかを残す（利用者の画面の文字なのでリポジトリの外へ）
  const out = process.env.EITHER_DEBUG_DIR;
  if (out) {
    writeFileSync(`${out}/either-remainder-fail.txt`, await page.locator("body").innerText().catch(() => ""));
    await page.screenshot({ path: `${out}/either-remainder-fail.png` }).catch(() => {});
  }
  throw e;
} finally {
  await browser.close();
  server.close?.();
}

for (const round of [...ROUND_NAMES, "I1"]) {
  const text = round === "I1" ? logs.I : logs.X;
  const got = text.match(new RegExp(`^\\[${round}\\] QsnRtvFldDta len=\\d+ hex=([0-9a-f]*)`, "m"))?.[1];
  check(got === ACS[round], `${round} のバイト列が ACS と同じ${got === ACS[round] ? "" : `\n    当 PJ: ${got}\n    ACS:   ${ACS[round]}`}`);
}
log(`RESULT: pass=${pass} fail=${fail}`);
process.exit(fail > 0 ? 1 : 0);
