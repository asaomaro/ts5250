// 実ブラウザ（web-ui）で実機へ接続し、**負値入力（Field−）と Dup** が端から端まで効くか検証する。
//
//   Field−  — 数値欄で `-` を打つと符号桁に `-` が入り、**ホストが負値として受け取る**
//   Field+  — 正値に戻る
//   Dup     — `DUP_ENABLE` の欄で複写文字（0x1C）が埋まり、アプリがそれを受け取る
//
// **負値が本当に届くかはここでしか分からない。** 単体テストは「符号桁に `-` を置く」ところと
// 「送信バイトが 40 40 40 40 F1 D2 になる」ところまでしか見ておらず、
// ホストがそれを −12 と解釈するかは実機に聞くほかない。
//
// 画面は `scripts/build-sgntest.mjs`（SGNPGM）が作る。
//
// 前提: npm run build 済み。`connections.json` に実機と DEV1。
// 実行: AS400_PASSWORD=... node scripts/verify-browser-sign.mjs
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { serve } from "@hono/node-server";
import { WebSocketServer } from "ws";
import { buildApp, SessionManager, ServerConfigStore, PersonalConfigStore, ConfigResolver } from "@ts5250/server";
import { SecretCrypto } from "../packages/server/dist/secret-crypto.js";
import { chromium } from "playwright";

const log = (s) => process.stderr.write(s + "\n");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const PORT = 3481;
const TMP = process.env.SGN_TMP ?? "/tmp/as400-verify-sign";
mkdirSync(TMP, { recursive: true });

const results = [];
const check = (n, ok, d = "") => {
  results.push({ n, ok });
  process.stdout.write(`${ok ? "OK  " : "NG  "} ${n}${d ? ` — ${d}` : ""}\n`);
};

const cfg = JSON.parse(readFileSync("connections.json", "utf8"));
const tmpCfg = `${TMP}/conn-sign.json`;
writeFileSync(tmpCfg, JSON.stringify(cfg));
const crypto = SecretCrypto.fromEnv();
const sys = cfg.systems.find((s) => s.name === (process.env.AS400_SYSTEM ?? "AS400"));
// **パスワードはスクリプトに書かない。** 環境変数か、暗号化済み設定の復号で得る（AGENTS.md セキュリティ）
const password = process.env.AS400_PASSWORD ?? crypto.decrypt(sys.signon.passwordEnc);
const user = sys.signon.user;

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
const inputs = () => page.locator("input.grid-input:not([readonly])");
const valueOf = async (i) => await inputs().nth(i).inputValue();
async function typeInto(i, text) {
  const el = inputs().nth(i);
  await el.click();
  await page.keyboard.press("Home");
  await page.keyboard.type(text, { delay: 20 });
  await sleep(150);
}
async function runCmd(text) {
  const el = inputs().last();
  await el.click();
  await page.keyboard.press("Home");
  await page.keyboard.type(text, { delay: 15 });
  await clickEnter();
  await sleep(1500);
}
/** ステータス行（操作員メッセージが出る所）のテキスト */
const statusText = () => page.locator(".oia").innerText().catch(() => "");

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

  if ((await has("サイン")) && (await has("ユーザー"))) {
    await typeInto(0, user);
    await typeInto(1, password);
    await clickEnter();
  }
  for (let i = 0; i < 20; i++) {
    await sleep(1400);
    if (await has("メインメニュー")) break;
    if (await has("対話式ジョブの回復")) {
      const el = inputs().last();
      await el.click();
      await page.keyboard.press("Home");
      await page.keyboard.type("90", { delay: 30 });
      await clickEnter();
    } else if (await has("SIGN / DUP TEST")) {
      await page.keyboard.press("F3"); // 前回のテスト画面が残っていたら抜ける
    } else await clickEnter();
  }
  const reached = await has("メインメニュー");
  if (!reached) log("---- 到達できなかった画面 ----\n" + (await bodyText()).slice(0, 2200));
  check("メインメニューに到達", reached);
  await runCmd("ADDLIBLE TESTLIB");

  await runCmd("CALL TESTLIB/SGNPGM");
  await page.waitForFunction(() => document.body.innerText.includes("SIGN / DUP TEST"), { timeout: 20000 });
  const n = await inputs().count();
  check("SGNPGM の画面が出る（入力欄 4）", n === 4, `count=${n}`);

  // 欄の並び: 0=SGN(6S 0) 1=NUM(6 0) 2=NMO(6M) 3=DUPF(DUP)
  // --- Field−: 数値欄で `-` を打つと符号桁へ入る（文字としては入らない）---
  await typeInto(0, "12");
  await page.keyboard.type("-", { delay: 30 });
  await sleep(300);
  const v0 = await valueOf(0);
  check("Field−: 符号桁に `-` が入り右寄せされる", v0 === "    12-", JSON.stringify(v0));

  // --- Field+: 正へ戻る ---
  await typeInto(1, "34");
  await page.keyboard.type("+", { delay: 30 });
  await sleep(300);
  const v1 = await valueOf(1);
  check("Field+: 符号桁が空白になる", v1.replace(/ +$/, "") === "    34", JSON.stringify(v1));

  // --- Dup: DUP_ENABLE の欄で複写文字が埋まる ---
  await inputs().nth(3).click();
  await page.keyboard.press("Home");
  await page.keyboard.press("Control+d");
  await sleep(300);
  const v3 = await valueOf(3);
  check("Dup: 欄が埋まる（複写文字は画面では空白）", v3.length === 6, JSON.stringify(v3));

  // --- ここが本番: ホストが受け取った値 ---
  await clickEnter();
  await sleep(2200);
  const screen = await bodyText();
  log("---- エコー ----\n" + screen.split("\n").filter((l) => l.includes("[")).join("\n"));
  check("**ホストが負値として受け取る**（Field− の結果）", screen.includes("[-12]"), "期待 [-12]");
  check("ホストが正値として受け取る（Field+ の結果）", screen.includes("[34]"), "期待 [34]");
  check("アプリが複写文字（0x1C×6）を受け取る", screen.includes("[ALLDUP]"), "期待 [ALLDUP]");

  // --- Dup が許されない欄では何もせずメッセージ ---
  await inputs().nth(0).click();
  await page.keyboard.press("Home");
  await page.keyboard.press("Control+d");
  await sleep(300);
  check("DUP_ENABLE でない欄では複写キーが効かない", (await statusText()).includes("複写キー"), await statusText());

  await page.keyboard.press("F3");
  await sleep(1500);
  // 装置を解放してから終わる（残すと次回が回復画面から始まる）
  try {
    await runCmd("SIGNOFF");
    await sleep(1500);
  } catch (e) {
    log("SIGNOFF できなかった: " + e.message);
  }
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
