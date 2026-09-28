// 実機検証（ブラウザ）: **符号付き数値の欄の MF・自己点検で符号の桁を数えない**（`20260928-mandatory-sign-digit`）。
//
// ACS のコア（`scripts/acs-probe/sign-digit-check.txt`）で測った 4 場合（MF に数字 5 桁 → 出られる・3 桁 → 止まる、自己点検に 12302 → 出られる・12305 → 止まる）を
// 同じ打鍵（Tab で欄を出る）でブラウザの当 PJ に当て、欄を出たか・操作員メッセージが出たかを比べる。DSM の SIGNCHK。
//
// 前提:
//   npm run build && npm run build -w @ts5250/web-ui
//   DSCMD_LIB=<AS400_LIB> node --env-file=.env --env-file=.env.verify scripts/build-dscmd.mjs
// 実行: node --env-file=.env --env-file=.env.verify scripts/verify-browser-sign-digit.mjs
// **終わったら DLTPGM と IFS の /tmp/dscmd.c・/tmp/dscmd.log を消す**。
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { serve } from "@hono/node-server";
import { WebSocketServer } from "ws";
import { buildApp, SessionManager, ServerConfigStore, PersonalConfigStore, ConfigResolver } from "@ts5250/server";
import { SecretCrypto } from "../packages/server/dist/secret-crypto.js";
import { chromium } from "playwright";

const log = (s) => process.stderr.write(s + "\n");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const PORT = 3493;
const LIB = (process.env.AS400_LIB ?? "TESTLIB").trim().split(/\s+/)[0];
const TMP = "/tmp/as400-verify-sign-digit";
mkdirSync(TMP, { recursive: true });
// `packages/web-ui/src/composables/opMessages.ts` の MSG_MANDATORY_FILL・MSG_SELF_CHECK
const MSG_MF = "この項目はすべての桁を埋めてください";
const MSG_SC = "この項目の検査数字が正しくありません";
/** [名前, 欄の番号, 打つ字, ACS の結果（pass＝出られた / mf・sc＝止まった）] */
const CASES = [
  ["a MF 数字 5 桁", 0, "12345", "pass"],
  ["b MF 数字 3 桁", 0, "123", "mf"],
  ["c 自己点検 12302", 1, "12302", "pass"],
  ["d 自己点検 12305", 1, "12305", "sc"]
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
      if (process.env.SIGN_DIGIT_DEBUG_DIR) log(`  signon: inputs=${await inputs().count()} userLen=${(await inputs().nth(0).inputValue()).trim().length} pwLen=${(await inputs().nth(1).inputValue()).trim().length}`);
      await page.keyboard.press("Enter");
    } else await page.keyboard.press("Enter");
  }
  await runCmd(`CALL ${LIB}/DSCMD PARM('SIGNCHK')`);
  await page.waitForFunction(() => document.querySelectorAll("input.grid-input:not([readonly])").length === 3, { timeout: 20000 });
  await sleep(800);
  const activeField = () => page.evaluate(() => Number(document.activeElement?.dataset?.fieldIndex ?? -1));
  const fieldIdx = async (i) => Number(await inputs().nth(i).getAttribute("data-field-index"));
  const body = () => page.locator("body").innerText();
  for (const [name, i, text, want] of CASES) {
    await at(i, 0);
    await page.keyboard.press("Alt+Delete"); // Erase EOF（前の場合の値を消す）
    await page.keyboard.type(text, { delay: 30 });
    await sleep(600);
    if (process.env.SIGN_DIGIT_DEBUG) await page.screenshot({ path: `${process.env.SIGN_DIGIT_DEBUG}/${name[0]}-before.png` });
    const before = await body();
    await page.keyboard.press("Tab");
    await sleep(400);
    const stayed = (await activeField()) === (await fieldIdx(i));
    if (process.env.SIGN_DIGIT_DEBUG) await page.screenshot({ path: `${process.env.SIGN_DIGIT_DEBUG}/${name[0]}-after.png` });
    if (process.env.SIGN_DIGIT_DEBUG) log(`  debug ${name}: value=${JSON.stringify(await inputs().nth(i).inputValue())} active=${await activeField()} idx=${await fieldIdx(i)} notice=${JSON.stringify(((await body()).match(/この項目[^\n]*/) ?? [""])[0])}`);
    const msg = (await body()).includes(want === "mf" ? MSG_MF : MSG_SC) && !before.includes(want === "mf" ? MSG_MF : MSG_SC);
    if (want === "pass") check(!stayed, `${name}: 欄を出た（ACS も出た）`);
    else check(stayed && msg, `${name}: 欄に留まり操作員メッセージ（ACS も止まった。stayed=${stayed} msg=${msg}）`);
    await page.keyboard.press("Control"); // Reset（左 Ctrl 単独。エラーを解く。Esc は Attn なので使わない）
    await sleep(200);
    // 次の場合の前にこの欄を空にする（違反を残したまま別の欄をクリックすると、ACS と同じく出られずにこの欄へ戻される）
    await at(i, 0);
    await page.keyboard.press("Alt+Delete");
    await sleep(200);
  }
  await at(2, 0);
  await page.keyboard.press("Enter");
  await sleep(2500);
  await sleep(1000);
  await runCmd("SIGNOFF");
  await sleep(1500);
} catch (e) {
  // どの画面で止まったかを残す（利用者の画面の文字なのでリポジトリの外へ）
  const out = process.env.SIGN_DIGIT_DEBUG_DIR;
  if (out) {
    writeFileSync(`${out}/sign-digit-fail.txt`, await page.locator("body").innerText().catch(() => ""));
    await page.screenshot({ path: `${out}/sign-digit-fail.png` }).catch(() => {});
  }
  throw e;
} finally {
  await browser.close();
  server.close?.();
}

log(`RESULT: pass=${pass} fail=${fail}`);
process.exit(fail > 0 ? 1 : 0);
