// 実機検証（ブラウザ）: **SI の無い E（open）への打鍵がホストへ ACS と同じバイト列で届くか**（`20260930-open-e`）。
//
// ACS のコア（`scripts/acs-probe/open-e-typing.txt`。DSM の OPENE）: compact の E の SO の次で Erase EOF して open にし、打つ。先頭の字は SO の次、2 字目以降は新しい `SO 字… SI` の組。
// 欄の長さを越える字（f5 の か）は入らない。READ MDT（`[V1]`）と ALT（`[V2]`）を欄ごとに比べる。
//
// 前提: npm run build && npm run build -w @ts5250/web-ui && DSCMD_LIB=<AS400_LIB> node --env-file=.env --env-file=.env.verify scripts/build-dscmd.mjs
// 実行: node --env-file=.env --env-file=.env.verify scripts/verify-browser-open-e.mjs
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
const PORT = 3507;
const LIB = (process.env.AS400_LIB ?? "TESTLIB").trim().split(/\s+/)[0];
const TMP = "/tmp/as400-verify-open-e";
mkdirSync(TMP, { recursive: true });

/** ACS のコアが送った欄ごとの欄データ（`open-e-typing.txt` の 2026-10-01 の実測）。READ MDT・ALT とも同じ */
const SAME = ["0e44820e44830f", "0e44820e40400f", "0e40400e44820f", "0e44820e448344840f", "0e44820e4040448344830f", "0e44820e4483448444850f"];
const ACS = { V1: SAME, V2: SAME };
const KNOWN_GAPS = new Set([]);

// 手順（欄の番号 0〜5、`at` は入力欄の view の位置: SO＝0・あ＝1）。各欄で SO の次から Erase EOF（Alt+Delete）して打つ
const typed = (...ops) => [["at", 1], ["key", "Alt+Delete"], ...ops];
const STEP = [
  [0, typed(["ime", "い"], ["ime", "う"])],
  [1, typed(["ime", "い"], ["type", " "], ["ime", "う"], ["key", "Backspace"])],
  [2, typed(["type", " "], ["ime", "い"])],
  [3, typed(["ime", "い"], ["ime", "う"], ["ime", "え"])],
  [4, typed(["ime", "い"], ["type", " "], ["ime", "う"], ["ime", "う"])],
  [5, typed(["ime", "い"], ["ime", "う"], ["ime", "え"], ["ime", "お"], ["ime", "か"])]
];
const STEPS = { V1: STEP, V2: STEP };
const ROUNDS = ["V1", "V2"];

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
      if (process.env.SPACE_TYPED_DEBUG_DIR) log(`  signon: inputs=${await inputs().count()} userLen=${(await inputs().nth(0).inputValue()).trim().length} pwLen=${(await inputs().nth(1).inputValue()).trim().length}`);
      await page.keyboard.press("Enter");
    } else await page.keyboard.press("Enter");
  }
  await runCmd(`CALL ${LIB}/DSCMD PARM('OPENE')`);
  await page.waitForFunction(() => document.querySelectorAll("input.grid-input:not([readonly])").length >= 6, { timeout: 20000 });
  await sleep(800);
  for (const round of ROUNDS) {
    for (const [i, steps] of STEPS[round]) {
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
  await runCmd("SIGNOFF");
  await sleep(1500);
} catch (e) {
  // どの画面で止まったかを残す（利用者の画面の文字なのでリポジトリの外へ）
  const out = process.env.SPACE_TYPED_DEBUG_DIR;
  if (out) {
    writeFileSync(`${out}/space-typed-fail.txt`, await page.locator("body").innerText().catch(() => ""));
    await page.screenshot({ path: `${out}/space-typed-fail.png` }).catch(() => {});
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
for (const round of ROUNDS) {
  // ホストが受け取った欄ごとのバイト列（DSM が `[T1]   flddta len=.. hex=..` の行で欄の順に出す）
  const got = [...text.matchAll(new RegExp(`^\\[${round}\\]   flddta len=\\d+ hex=([0-9a-f]*)`, "gm"))].map((m) => m[1]);
  ACS[round].forEach((want, i) => {
    const name = `${round} の f${i}`;
    const same = got[i] === want;
    if (!same && KNOWN_GAPS.has(`f${i}`)) log(`  KNOWN ${name}（未対応の欄）\n    当 PJ: ${got[i]}\n    ACS:   ${want}`);
    else check(same, `${name} のバイト列が ACS と同じ${same ? "" : `\n    当 PJ: ${got[i]}\n    ACS:   ${want}`}`);
  });
}
log(`RESULT: pass=${pass} fail=${fail}`);
process.exit(fail > 0 ? 1 : 0);
