// 実機検証（ブラウザ）: **継続した O 欄への貼り付け（と同じ文字列の打鍵）がホストへ ACS と同じバイト列で届くか**（`20260930-cont-o-paste`）。
//
// ACS のコア（`scripts/acs-probe/cont-o-paste.txt`。GUI の Ctrl+V の入口 `ECLPS.pasteLineWrap`）で測った 8 通り（1〜4 が貼り付け、5〜8 が同じ文字列の打鍵）を、
// ブラウザの当 PJ に当て、ホストが受け取った READ MDT ALT のバイト列とカーソル（DSM の CONTOP の /tmp/dscmd.log の `[P1]`〜`[P8]`）を巡ごとに比べる。
// 巡ごとに画面が書き直されるので、1 巡に 1 件だけ操作して Enter。全角は実 IME（CDP の `Input.imeSetComposition`＋`insertText`）で打つ。
//
// **既知の差 2 つ（この巡では比べない。台帳）**:
// - P3: 貼った全角（い）が区間の残り桁に入らないとき、ACS は打鍵と同じく次の区間へ送って置き（そこで貼り付けが止まる）、当 PJ は置かない
// - P4 のカーソル: ACS のプローブの貼り付けはカーソルを動かさない（開始位置は引数）が、ブラウザは欄をクリックして貼るのでカーソルが貼り付け位置にある（操作の違い）
//
// 前提:
//   npm run build && npm run build -w @ts5250/web-ui
//   DSCMD_LIB=<AS400_LIB> node --env-file=.env --env-file=.env.verify scripts/build-dscmd.mjs
// 実行: node --env-file=.env --env-file=.env.verify scripts/verify-browser-cont-o-paste.mjs
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
const PORT = 3500;
const LIB = (process.env.AS400_LIB ?? "TESTLIB").trim().split(/\s+/)[0];
const TMP = "/tmp/as400-verify-cont-o-paste";
mkdirSync(TMP, { recursive: true });

/** ACS のコアが送った欄データ（SBA の後ろ）とカーソル（`cont-o-paste.txt` の 2026-09-30 の実測） */
const ACS = {
  P1: ["0e4481448244830f", "5,10"],
  P2: ["c1c2c3c4c5c6c7c8", "5,10"],
  P3: ["c10e44810fc200000e44820f", "5,10"],
  P4: ["00000e448144820f", "5,10"],
  P5: ["0e448144824483448444854486448744880f", "7,15"],
  P6: ["c1c2c3c4c5c6c7c8c9d1d2d3d4d5d6d7", "7,10"],
  P7: ["c10e44810fc200000e44820fc30000000e44830f", "7,13"],
  P8: ["00000e448144820f", "6,10"]
};
/** 比べない項目（上の既知の差） */
const SKIP = new Set(["P3", "P4:cursor"]);
const TEXTS = { P1: "あいうえおかきく", P2: "ABCDEFGHIJKLMNOP", P3: "AあBいCう", P4: "あい" };
// 手順（区間の番号 0〜2、`at` は入力欄の view の位置）。1〜4 は貼り付け、5〜8 は同じ文字列の打鍵（全角は IME、半角は type）
const typed = (text) => [...text].map((ch) => (/[\u3040-\u30ff]/.test(ch) ? ["ime", ch] : ["type", ch]));
const ROUNDS = {
  P1: [["at", 0, 0], ["paste", TEXTS.P1]],
  P2: [["at", 0, 0], ["paste", TEXTS.P2]],
  P3: [["at", 0, 0], ["paste", TEXTS.P3]],
  P4: [["at", 0, 2], ["paste", TEXTS.P4]],
  P5: [["at", 0, 0], ...typed(TEXTS.P1)],
  P6: [["at", 0, 0], ...typed(TEXTS.P2)],
  P7: [["at", 0, 0], ...typed(TEXTS.P3)],
  P8: [["at", 0, 2], ...typed(TEXTS.P4)]
};
TEXTS.P5 = TEXTS.P1;
TEXTS.P6 = TEXTS.P2;
TEXTS.P7 = TEXTS.P3;
TEXTS.P8 = TEXTS.P4;

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
/** フォーカス中の要素へ text をペースト（クリップボード権限なしで paste 経路を叩く。`verify-browser-paste.mjs` と同じ） */
const paste = (text) => page.evaluate((t) => {
  const el = document.activeElement;
  const dt = new DataTransfer();
  dt.setData("text/plain", t);
  el.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
}, text);
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
      if (process.env.CONT_O_PASTE_DEBUG_DIR) log(`  signon: inputs=${await inputs().count()} userLen=${(await inputs().nth(0).inputValue()).trim().length} pwLen=${(await inputs().nth(1).inputValue()).trim().length}`);
      await page.keyboard.press("Enter");
    } else await page.keyboard.press("Enter");
  }
  await runCmd(`CALL ${LIB}/DSCMD PARM('CONTOP')`);
  await page.waitForFunction(() => document.querySelectorAll("input.grid-input:not([readonly])").length === 3, { timeout: 20000 });
  await sleep(800);
  for (const [round, steps] of Object.entries(ROUNDS)) {
    for (const [op, a, b] of steps) {
      if (op === "at") await at(a, b);
      else if (op === "type") await page.keyboard.type(a, { delay: 30 });
      else if (op === "ime") await ime(a);
      else if (op === "paste") { await paste(a); await sleep(400); }
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
  const out = process.env.CONT_O_PASTE_DEBUG_DIR;
  if (out) {
    writeFileSync(`${out}/cont-o-paste-fail.txt`, await page.locator("body").innerText().catch(() => ""));
    await page.screenshot({ path: `${out}/cont-o-paste-fail.png` }).catch(() => {});
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
  const want = bytes;
  if (SKIP.has(round)) log(`  SKIP ${round}（既知の差。ファイル先頭）`);
  else check(got === want, `${round} のバイト列が ACS と同じ${got === want ? "" : `\n    当 PJ: ${got}\n    ACS:   ${want}`}`);
  const adr = text.match(new RegExp(`^\\[${round}\\] QsnRtvReadAdr row=(\\d+) col=(\\d+)`, "m"));
  const gotCursor = adr ? `${adr[1]},${adr[2]}` : undefined;
  if (SKIP.has(`${round}:cursor`) || SKIP.has(round)) log(`  SKIP ${round} のカーソル`);
  else check(gotCursor === cursor, `${round} のカーソルが ACS と同じ（${gotCursor} / ${cursor}）`);
}
log(`RESULT: pass=${pass} fail=${fail}`);
process.exit(fail > 0 ? 1 : 0);
