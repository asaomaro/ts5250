// 実機検証（ブラウザ）: **継続した O 欄の編集がホストへ ACS と同じバイト列で届くか**（`20260928-cont-o-cells`）。
//
// ACS のコア（`scripts/acs-probe/cont-o-edit.txt`）で測った 12 通り（挿入 8・上書き 1・Delete・Backspace・Erase EOF）を、同じ打鍵でブラウザの当 PJ に当て、
// ホストが受け取った READ MDT のバイト列とカーソル（DSM の CONTOX の /tmp/dscmd.log の `[C01]`〜`[C12]`）を ACS の値と巡ごとに比べる。
// 巡ごとに画面が書き直されるので、1 巡に 1 件だけ打鍵して Enter。全角は実 IME（CDP の `Input.imeSetComposition`＋`insertText`）で打つ。
// Erase EOF は既定のキーが無いので Alt+Delete に割り当てる。
// C09・C10（空白埋め）は、ACS が末尾の空白（0x40）を中身として最終区間まで押し出して送る——当 PJ の O 欄の値は空きと空白を区別しないので送らない
// （既知の差。台帳）。この 2 巡は末尾の `40` を除いて比べる。
//
// 前提:
//   npm run build && npm run build -w @ts5250/web-ui
//   DSCMD_LIB=<AS400_LIB> node --env-file=.env --env-file=.env.verify scripts/build-dscmd.mjs
// 実行: node --env-file=.env --env-file=.env.verify scripts/verify-browser-cont-o.mjs
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
const PORT = 3492;
const LIB = (process.env.AS400_LIB ?? "TESTLIB").trim().split(/\s+/)[0];
const TMP = "/tmp/as400-verify-cont-o";
mkdirSync(TMP, { recursive: true });

/** ACS のコアが送った欄データ（SBA の後ろ）とカーソル（`cont-o-edit.txt` の 2026-09-28 の実測。research F2） */
const ACS = {
  C01: ["0e4482448444830fe740e8e9", "6,10"],
  C02: ["0e448244840f40400e44840fe740e8e9", "6,13"],
  C03: ["0e448244840fe7400e44850fe8e9", "6,13"],
  C04: ["0e0fd80e44820f400e44840fe740e8e9", "5,13"],
  C05: ["0e448244840fe7400e44860f", "6,13"],
  C06: ["0e44840fe740e8e9", "5,11"],
  C07: ["0e448244840fe7e8e9", "5,17"],
  C08: ["0e44820f", "5,13"],
  C09: ["0e4482448444830fe740e8e9404040404040", "6,10"],
  C10: ["0e448244840f40400e44840fe740e8e9404040404040", "6,13"],
  C11: ["0e4487448244840fe740e8e9", "5,13"],
  C12: ["0e44824487448844840fe740e8e9", "6,10"]
};
/** 末尾の空白を除いて比べる巡（空きと空白を区別しない既知の差） */
const TRIM40 = new Set(["C09", "C10"]);

// 手順（区間の番号 0〜2、`at` は入力欄の view の位置——SO・SI の印が 1 桁ずつ、全角は 1 字。先頭の区間は SO=0・い=1・え=2・SI=3・X=4）
const ROUNDS = {
  C01: [["at", 0, 3], ["key", "Insert"], ["ime", "う"]],
  C02: [["at", 0, 4], ["key", "Insert"], ["ime", "え"]],
  C03: [["at", 1, 0], ["key", "Insert"], ["ime", "お"]],
  C04: [["at", 0, 1], ["key", "Insert"], ["type", "Q"]],
  C05: [["at", 0, 4], ["ime", "か"]],
  C06: [["at", 0, 1], ["key", "Delete"]],
  C07: [["at", 1, 0], ["key", "Backspace"]],
  C08: [["at", 0, 2], ["key", "Alt+Delete"]],
  C09: [["at", 0, 3], ["key", "Insert"], ["ime", "う"]],
  C10: [["at", 0, 4], ["key", "Insert"], ["ime", "え"]],
  C11: [["at", 0, 0], ["key", "Insert"], ["ime", "き"]],
  C12: [["at", 0, 2], ["key", "Insert"], ["ime", "き"], ["ime", "く"]]
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
      if (process.env.CONT_O_DEBUG_DIR) log(`  signon: inputs=${await inputs().count()} userLen=${(await inputs().nth(0).inputValue()).trim().length} pwLen=${(await inputs().nth(1).inputValue()).trim().length}`);
      await page.keyboard.press("Enter");
    } else await page.keyboard.press("Enter");
  }
  await runCmd(`CALL ${LIB}/DSCMD PARM('CONTOX')`);
  await page.waitForFunction(() => document.querySelectorAll("input.grid-input:not([readonly])").length === 3, { timeout: 20000 });
  await sleep(800);
  for (const [round, steps] of Object.entries(ROUNDS)) {
    for (const [op, a, b] of steps) {
      if (op === "at") await at(a, b);
      else if (op === "type") await page.keyboard.type(a, { delay: 30 });
      else if (op === "ime") await ime(a);
      else await page.keyboard.press(a);
      await sleep(80);
    }
    // Enter は打鍵の後のカーソルのまま送る（ACS も同じ）。挿入モードは新しい画面で下りる
    await page.keyboard.press("Enter");
    await sleep(2500);
    log(`  ${round} done`);
  }
  await sleep(1000);
  await runCmd("SIGNOFF");
  await sleep(1500);
} catch (e) {
  // どの画面で止まったかを残す（利用者の画面の文字なのでリポジトリの外へ）
  const out = process.env.CONT_O_DEBUG_DIR;
  if (out) {
    writeFileSync(`${out}/cont-o-fail.txt`, await page.locator("body").innerText().catch(() => ""));
    await page.screenshot({ path: `${out}/cont-o-fail.png` }).catch(() => {});
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
for (const [round, [bytes, cursor]] of Object.entries(ACS)) {
  const got = text.match(new RegExp(`^\\[${round}\\] QsnRtvFldDta len=\\d+ hex=11050a([0-9a-f]*)`, "m"))?.[1];
  const want = TRIM40.has(round) ? bytes.replace(/(40)+$/, "") : bytes;
  check(got === want, `${round} のバイト列が ACS と同じ${got === want ? "" : `\n    当 PJ: ${got}\n    ACS:   ${want}`}`);
  const adr = text.match(new RegExp(`^\\[${round}\\] QsnRtvReadAdr row=(\\d+) col=(\\d+)`, "m"));
  const gotCursor = adr ? `${adr[1]},${adr[2]}` : undefined;
  check(gotCursor === cursor, `${round} のカーソルが ACS と同じ（${gotCursor} / ${cursor}）`);
}
log(`RESULT: pass=${pass} fail=${fail}`);
process.exit(fail > 0 ? 1 : 0);
