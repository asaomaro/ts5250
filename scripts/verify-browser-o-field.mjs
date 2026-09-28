// 実機検証（ブラウザ）: **O 欄の編集がホストへ ACS と同じバイト列で届くか**（`20260928-o-field-cells`）。
//
// ACS のコア（`scripts/acs-probe/o-field-edit.txt`）で測った 24 通り（上書き 8・挿入 8・削除系 8）を、同じ打鍵でブラウザの当 PJ に当て、
// ホストが受け取った READ MDT のバイト列（DSM の OEDIT の /tmp/dscmd.log の `[O1]`〜`[O3]`）を ACS の値と巡ごとに比べる。
// 全角は実 IME（CDP の `Input.imeSetComposition`＋`insertText`）で打つ。Erase EOF は既定のキーが無いので Alt+Delete に割り当てる。
// 操作員エラーの場合はクリックで抜けるので、各巡の最後に回した（手順の順は違っても、ホストへ届くのは欄の順）。
//
// 前提:
//   npm run build && npm run build -w @ts5250/web-ui
//   DSCMD_LIB=<AS400_LIB> node --env-file=.env --env-file=.env.verify scripts/build-dscmd.mjs
// 実行: node --env-file=.env --env-file=.env.verify scripts/verify-browser-o-field.mjs
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
const PORT = 3491;
const LIB = (process.env.AS400_LIB ?? "TESTLIB").trim().split(/\s+/)[0];
const TMP = "/tmp/as400-verify-o-field";
mkdirSync(TMP, { recursive: true });

/** ACS のコアが送ったバイト列（`o-field-edit.txt` の 2026-09-28 の実測） */
const ACS = {
  O1: "11030a0e44810f11050a0e448144820f11070a0e44810fe711090a0e0fe7400e0f110b0ae7400e0f110d0a0e44810f110f0ac1c2c3c4c5c6c7c8c9d1d211110a0e44820fe7",
  O2: "11030ac10e44810fc211050a0e44810f0e44820fc211070a0e0fe70e448144820f11090a0e448144820f110b0ae70e44810f110d0a0e44810fe7110f0ac1c2c3c4c5c6c7c8c9d1d2d311110a0e448244810f",
  O3: "11030a0e0f11050a0e44810f11070a0e44810fe711090a0e44820f110b0ac1c2110d0a0e44810f110f0a0e44810f11110a0e448144820f"
};

// 手順（欄の番号 0〜7、`at` は入力欄の view の位置——O 欄は SO・SI の印が 1 桁ずつ）
const ROUNDS = {
  O1: [
    [0, [["at", 0], ["type", "ABCD"], ["at", 0], ["ime", "あ"]]],
    [1, [["at", 0], ["ime", "あ"], ["at", 2], ["ime", "い"]]],
    [2, [["at", 0], ["ime", "あ"], ["at", 2], ["type", "X"]]],
    [3, [["at", 0], ["ime", "あい"], ["at", 1], ["type", "X"]]],
    [4, [["at", 0], ["ime", "あ"], ["at", 0], ["type", "X"]]],
    [5, [["at", 0], ["type", "AB"], ["at", 0], ["ime", "あ"]]],
    [7, [["at", 0], ["ime", "あ"], ["type", "X"], ["at", 0], ["ime", "い"]]],
    [6, [["at", 0], ["type", "ABCDEFGHIJK"], ["at", 10], ["ime", "あ"]]] // 0005
  ],
  O2: [
    [0, [["at", 0], ["type", "AB"], ["at", 1], ["key", "Insert"], ["ime", "あ"], ["key", "Insert"]]],
    [1, [["at", 0], ["ime", "あ"], ["type", "B"], ["at", 3], ["key", "Insert"], ["ime", "い"], ["key", "Insert"]]],
    [2, [["at", 0], ["ime", "あい"], ["at", 1], ["key", "Insert"], ["type", "X"], ["key", "Insert"]]],
    [3, [["at", 0], ["ime", "あ"], ["at", 2], ["key", "Insert"], ["ime", "い"], ["key", "Insert"]]],
    [4, [["at", 0], ["ime", "あ"], ["at", 0], ["key", "Insert"], ["type", "X"], ["key", "Insert"]]],
    [5, [["at", 0], ["ime", "あ"], ["at", 2], ["key", "Insert"], ["type", "X"], ["key", "Insert"]]],
    [7, [["at", 0], ["ime", "あ"], ["at", 0], ["key", "Insert"], ["ime", "い"], ["key", "Insert"]]],
    [6, [["at", 0], ["type", "ABCDEFGHIJKL"], ["at", 1], ["key", "Insert"], ["type", "X"]]] // 0012
  ],
  O3: [
    [0, [["at", 0], ["ime", "あ"], ["at", 1], ["key", "Delete"]]],
    [3, [["at", 0], ["ime", "あい"], ["at", 2], ["key", "Backspace"]]],
    [4, [["at", 0], ["type", "AB"], ["ime", "あ"], ["at", 2], ["key", "Alt+Delete"]]],
    [5, [["at", 0], ["ime", "あいう"], ["at", 2], ["key", "Alt+Delete"]]],
    [7, [["at", 0], ["ime", "あ"], ["at", 3], ["ime", "い"], ["at", 2], ["key", "Delete"]]],
    [1, [["at", 0], ["ime", "あ"], ["at", 0], ["key", "Delete"]]], // 0065
    [2, [["at", 0], ["ime", "あ"], ["type", "X"], ["at", 3], ["key", "Backspace"]]], // 0065
    [6, [["at", 0], ["ime", "あ"], ["at", 2], ["key", "Delete"]]] // 0065
  ]
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
      if (process.env.O_FIELD_DEBUG_DIR) log(`  signon: inputs=${await inputs().count()} userLen=${(await inputs().nth(0).inputValue()).trim().length} pwLen=${(await inputs().nth(1).inputValue()).trim().length}`);
      await page.keyboard.press("Enter");
    } else await page.keyboard.press("Enter");
  }
  await runCmd(`CALL ${LIB}/DSCMD PARM('OEDIT')`);
  await page.waitForFunction(() => document.querySelectorAll("input.grid-input:not([readonly])").length >= 8, { timeout: 20000 });
  await sleep(800);
  for (const round of ["O1", "O2", "O3"]) {
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
  await runCmd("SIGNOFF");
  await sleep(1500);
} catch (e) {
  // どの画面で止まったかを残す（利用者の画面の文字なのでリポジトリの外へ）
  const out = process.env.O_FIELD_DEBUG_DIR;
  if (out) {
    writeFileSync(`${out}/o-field-fail.txt`, await page.locator("body").innerText().catch(() => ""));
    await page.screenshot({ path: `${out}/o-field-fail.png` }).catch(() => {});
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
for (const round of ["O1", "O2", "O3"]) {
  const got = text.match(new RegExp(`^\\[${round}\\] QsnRtvFldDta len=\\d+ hex=([0-9a-f]*)`, "m"))?.[1];
  check(got === ACS[round], `${round} のバイト列が ACS と同じ${got === ACS[round] ? "" : `\n    当 PJ: ${got}\n    ACS:   ${ACS[round]}`}`);
}
log(`RESULT: pass=${pass} fail=${fail}`);
process.exit(fail > 0 ? 1 : 0);
