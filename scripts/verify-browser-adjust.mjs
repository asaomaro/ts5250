// 実ブラウザ（web-ui）で実機へ接続し、**ローカル編集キーと FFW の ADJUST（右寄せ）**を検証する。
//
//   Field Exit（Ctrl+Enter）  — 欄の残りを消して FFW どおり右寄せし、次の欄へ
//   Erase EOF（Ctrl+Delete）  — カーソルから欄末尾まで消去（欄は出ない・右寄せしない）
//   Erase Input（Ctrl+Backspace）— すべての入力欄をクリア
//
// 画面は `scripts/build-adjtest.mjs` が作る TESTLIB/ADJPGM。
// **最後に Enter を送り、ホストが受け取った値（RPG が `[...]` で返す）まで確かめる**——
// 画面上で右寄せできているだけでは、送信経路（core の内容検証・末尾空白の扱い）を通った保証がない。
//
// 前提: npm run build 済み。`connections.json` に実機と DEV1。
// 実行: node --env-file=.env scripts/verify-browser-adjust.mjs
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { serve } from "@hono/node-server";
import { WebSocketServer } from "ws";
import { buildApp, SessionManager, ServerConfigStore, PersonalConfigStore, ConfigResolver } from "@ts5250/server";
import { SecretCrypto } from "../packages/server/dist/secret-crypto.js";
import { chromium } from "playwright";

const log = (s) => process.stderr.write(s + "\n");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const PORT = 3477;
const TMP = process.env.ADJ_TMP ?? "/tmp/as400-verify-adjust";
mkdirSync(TMP, { recursive: true });

const results = [];
const check = (n, ok, d = "") => {
  results.push({ n, ok });
  process.stdout.write(`${ok ? "OK  " : "NG  "} ${n}${d ? ` — ${d}` : ""}\n`);
};

// connections.json をそのまま使う（DEV1=既存装置。ユニーク名は QAUTOVRT 上限に当たるため再利用）
const cfg = JSON.parse(readFileSync("connections.json", "utf8"));
const tmpCfg = `${TMP}/conn-adjust.json`;
writeFileSync(tmpCfg, JSON.stringify(cfg));
const crypto = SecretCrypto.fromEnv();
// **パスワードはスクリプトに書かない。** 既存の暗号化済み設定を復号して使う（AGENTS.md セキュリティ）
const password = crypto.decrypt(cfg.systems.find((s) => s.name === (process.env.AS400_SYSTEM ?? "AS400")).signon.passwordEnc);
const user = cfg.systems.find((s) => s.name === (process.env.AS400_SYSTEM ?? "AS400")).signon.user;

const resolver = new ConfigResolver(
  ServerConfigStore.fromFile(tmpCfg, crypto),
  new PersonalConfigStore({ systems: [], sessions: [] }, crypto)
);
const app = buildApp({ sessions: new SessionManager(), resolver, version: "verify", webRoot: "packages/web-ui/dist" });
const wss = new WebSocketServer({ noServer: true });
const server = serve({ fetch: app.fetch, port: PORT, websocket: { server: wss } });
await sleep(600);

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1500, height: 820 } });
page.on("pageerror", (e) => log("PAGEERR " + e.message));

const bodyText = () => page.locator("body").innerText();
const has = async (t) => (await bodyText()).includes(t);
const clickEnter = async () => {
  const b = page.getByText("⏎ 実行", { exact: false }).first();
  if (await b.count()) await b.click();
  else await page.keyboard.press("Enter");
};
/** 入力欄（読み取り専用でないもの）を画面順で取る */
const inputs = () => page.locator("input.grid-input:not([readonly])");
const valueOf = async (i) => await inputs().nth(i).inputValue();
/** i 番目の入力欄へ値を打ち込む（先頭から） */
async function typeInto(i, text) {
  const el = inputs().nth(i);
  await el.click();
  await page.keyboard.press("Home");
  await page.keyboard.type(text, { delay: 20 });
  await sleep(120);
}
/** コマンド行（画面最後の入力欄）へ打ってから Enter */
async function runCmd(text) {
  const el = inputs().last();
  await el.click();
  await page.keyboard.press("Home");
  await page.keyboard.type(text, { delay: 15 });
  await clickEnter();
  await sleep(1500);
}

try {
  await page.goto(`http://localhost:${PORT}/`);
  await page.waitForSelector(".launcher", { timeout: 20000 });
  await page.click(".card:has-text('実機') >> button:has-text('選択')");
  await page.waitForSelector(".card:has-text('DEV1')", { timeout: 10000 });
  await page.click(".card:has-text('DEV1') >> button:has-text('接続')");
  await page.waitForFunction(
    () => /サインオン|ユーザー|回復|メインメニュー/.test(document.body.innerText),
    { timeout: 25000 }
  );
  await sleep(900);

  if ((await has("サインオン")) || (await has("ユーザー"))) {
    await inputs().nth(0).pressSequentially(user, { delay: 40 });
    await sleep(120);
    await inputs().nth(1).pressSequentially(password, { delay: 40 });
    await sleep(200);
    await clickEnter();
  }
  // 情報画面・前ジョブの回復画面を捌いてコマンド画面へ。**装置名を使い回す**ため、
  // 前回のジョブが残っていると回復画面から始まる（scripts/README.md）
  for (let i = 0; i < 12; i++) {
    await sleep(1200);
    if (await has("メインメニュー")) break;
    if (await has("対話式ジョブの回復")) {
      const el = inputs().last();
      await el.click();
      await page.keyboard.press("Home");
      await page.keyboard.type("90", { delay: 30 });
      await clickEnter();
    } else if (await has("FFW ADJUST TEST")) {
      await page.keyboard.press("F3"); // 前回の ADJPGM が残っていたら抜ける
    } else await clickEnter();
  }
  const reached = await has("メインメニュー");
  if (!reached) log("---- 到達できなかった画面 ----\n" + (await bodyText()).slice(0, 800));
  check("メインメニューに到達", reached);

  await runCmd("ADDLIBLE TESTLIB");
  await runCmd("CALL TESTLIB/ADJPGM");
  await page.waitForFunction(() => document.body.innerText.includes("FFW ADJUST TEST"), { timeout: 20000 });
  check("ADJPGM の画面が出る", await has("FFW ADJUST TEST"));

  const n = await inputs().count();
  check("入力欄が 9 つある（DDS の CASES 順）", n === 9, `count=${n}`);

  // ---- Field Exit（Ctrl+Enter）: 右寄せして次の欄へ ----
  // 欄 0=CHECK(RZ) 英数字。"12" → 000012
  await typeInto(0, "12");
  await page.keyboard.press("Control+Enter");
  await sleep(300);
  check("Field Exit: CHECK(RZ) 欄がゼロ埋めで右寄せされる", (await valueOf(0)) === "000012", JSON.stringify(await valueOf(0)));

  // Field Exit は次の入力欄へ進む（フォーカスが欄 1 に居るはず）
  const focused = await page.evaluate(() => {
    const el = document.activeElement;
    const all = [...document.querySelectorAll("input.grid-input:not([readonly])")];
    return all.indexOf(el);
  });
  check("Field Exit: フォーカスが次の入力欄へ進む", focused === 1, `focusIndex=${focused}`);

  // 欄 1=CHECK(RB)。"12" → "    12"
  await typeInto(1, "12");
  await page.keyboard.press("Control+Enter");
  await sleep(300);
  check("Field Exit: CHECK(RB) 欄が空白埋めで右寄せされる", (await valueOf(1)) === "    12", JSON.stringify(await valueOf(1)));

  // 欄 2=CHECK(MF)。右寄せ**しない**（充填の検証指定であって右寄せではない）
  await typeInto(2, "12");
  await page.keyboard.press("Control+Enter");
  await sleep(300);
  check("Field Exit: CHECK(MF) 欄は桁を動かさない", (await valueOf(2)).startsWith("12"), JSON.stringify(await valueOf(2)));

  // Field Exit はカーソル以降を消す（欄 5=素の英数字に "ABCDEF" を入れ、途中で Field Exit）
  await typeInto(5, "ABCDEF");
  await inputs().nth(5).click();
  await page.evaluate(() => {
    const all = [...document.querySelectorAll("input.grid-input:not([readonly])")];
    all[5].focus();
    all[5].setSelectionRange(2, 2);
  });
  await page.keyboard.press("Control+Enter");
  await sleep(300);
  check("Field Exit: カーソル以降が消える", (await valueOf(5)).replace(/ +$/, "") === "AB", JSON.stringify(await valueOf(5)));

  // ---- Erase EOF（Ctrl+Delete）: 消すだけ・欄は出ない・右寄せしない ----
  await typeInto(3, "ABCDEF");
  await page.evaluate(() => {
    const all = [...document.querySelectorAll("input.grid-input:not([readonly])")];
    all[3].focus();
    all[3].setSelectionRange(3, 3);
  });
  await page.keyboard.press("Control+Delete");
  await sleep(300);
  const afterEof = await valueOf(3);
  check("Erase EOF: カーソル以降だけ消える", afterEof.replace(/ +$/, "") === "ABC", JSON.stringify(afterEof));
  const stillHere = await page.evaluate(() => {
    const all = [...document.querySelectorAll("input.grid-input:not([readonly])")];
    return all.indexOf(document.activeElement);
  });
  check("Erase EOF: 欄から出ない", stillHere === 3, `focusIndex=${stillHere}`);

  // ---- Erase Input（Ctrl+Backspace）: 全入力欄をクリア ----
  await page.keyboard.press("Control+Backspace");
  await sleep(400);
  const allVals = [];
  for (let i = 0; i < n; i++) allVals.push((await valueOf(i)).trim());
  check("Erase Input: すべての入力欄が空になる", allVals.every((v) => v === ""), JSON.stringify(allVals));

  // ---- 送信まで通す: Field Exit した値がホストへ右寄せで届くか ----
  await typeInto(0, "12");
  await page.keyboard.press("Control+Enter");
  await sleep(200);
  await typeInto(1, "12");
  await page.keyboard.press("Control+Enter");
  await sleep(200);
  await typeInto(6, "12"); // 欄 6 = CHECK(RZ) の数値欄（実機は signed-num・長さ 桁数+1 で送ってくる）
  await page.keyboard.press("Control+Enter");
  await sleep(300);
  // signed-num は ADJUST 指定より優先して**空白**で右寄せし、最終桁（符号桁）を動かさない
  const numVal = await valueOf(6);
  check(
    "Field Exit: 数値欄（signed-num）は空白で右寄せし符号桁を残す",
    numVal.replace(/ +$/, "") === "    12",
    JSON.stringify(numVal)
  );
  await clickEnter(); // ホストへ送る
  await sleep(2000);

  const screen = await bodyText();
  log("---- エコー画面 ----\n" + screen.split("\n").filter((l) => l.includes("[")).join("\n"));
  check("ホストが CHECK(RZ) 欄をゼロ埋め右寄せで受け取る", screen.includes("[000012]"), "期待 [000012]");
  check("ホストが CHECK(RB) 欄を空白埋め右寄せで受け取る", screen.includes("[    12]"), "期待 [    12]");
  check("数値欄も送信できる（内容検証が空白 padding を弾かない）", screen.includes("[12]"), "期待 [12]");

  await page.keyboard.press("F3");
  await sleep(1200);
} catch (e) {
  check("例外なく完走", false, e.message);
  log(e.stack ?? "");
} finally {
  await browser.close();
  server.close();
  wss.close();
}

const failed = results.filter((r) => !r.ok);
process.stdout.write(`\n${results.length - failed.length}/${results.length} passed\n`);
process.exit(failed.length === 0 ? 0 : 1);
