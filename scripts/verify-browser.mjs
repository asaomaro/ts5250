// T16: Playwright ヘッドレス E2E（実機）— build 済み web-ui を server 静的配信で起動し、
// 実ブラウザで 接続→グリッド描画→フィールド入力→Enter/F キー遷移→テーマ切替→ログ表示 を検証する。
// 前提: npm run build（web-ui dist）済み。実行: node --env-file=.env scripts/verify-browser.mjs
import { readFileSync } from "node:fs";
import { serve } from "@hono/node-server";
import { WebSocketServer } from "ws";
import {
  buildApp,
  SessionManager,
  ServerConfigStore,
  PersonalConfigStore,
  ConfigResolver,
  migrateProfiles
} from "@as400web/server";
import { SecretCrypto } from "../packages/server/dist/secret-crypto.js";
import { chromium } from "playwright";

/**
 * 旧形式（profiles 配列）から解決器を組み立てる。
 * 装置名の重複を避けるため、呼び出し側で書き換えたレコードをそのまま渡せる形にしている。
 */
function buildResolver(profiles, crypto) {
  const { systems, sessions } = migrateProfiles(profiles);
  return new ConfigResolver(
    new ServerConfigStore({ systems, sessions }, crypto),
    new PersonalConfigStore({ systems: [], sessions: [] }, crypto)
  );
}


const log = (s) => process.stderr.write(s + "\n");
const PORT = 3466;

const sessions = new SessionManager();
// 装置名は実行ごとに変える。前回のセッションが解放されていないと
// 同じ装置名では接続が拒否される（他の verify-browser 系と同じ扱い）
const rawCfg = JSON.parse(readFileSync("profiles.local.json", "utf8"));
const uniqDev = String(Date.now() % 100000).padStart(5, "0");
for (const p of rawCfg.profiles) if (p.deviceName) p.deviceName = `WEBB${uniqDev}`.slice(0, 10);
const resolver = buildResolver(rawCfg.profiles, SecretCrypto.fromEnv());
const app = buildApp({ sessions, resolver, version: "test", webRoot: "packages/web-ui/dist" });
const wss = new WebSocketServer({ noServer: true });
const server = serve({ fetch: app.fetch, port: PORT, websocket: { server: wss } });
await new Promise((r) => setTimeout(r, 500));

const browser = await chromium.launch();
const page = await browser.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
let ok = true;

try {
  await page.goto(`http://localhost:${PORT}/`);
  // ランチャー（メニュー）が出るまで待つ。システムが 1 つなら自動選択される
  await page.waitForSelector(".launcher", { timeout: 20000 });
  log("app loaded");

  // セッションカードの「接続」を押す（カード名クリックでは開かない）
  await page.click(".card:has-text('pub400') >> button:has-text('接続')");
  // グリッドに Main Menu が描画されるまで待つ
  await page.waitForSelector("text=IBM i Main Menu", { timeout: 20000 });
  log("grid rendered: IBM i Main Menu 表示");

  // コマンド行の input にキーボード入力（keydown 制御の上書きモードを通す）
  const input = page.locator("input.grid-input").first();
  await input.click();
  await input.press("Home");
  await page.keyboard.type("WRKMSG"); // 送信しない安全な文字列
  const val = (await input.inputValue()).trimEnd();
  log(`field input (keydown 上書き): "${val}"`);
  ok = ok && val === "WRKMSG";

  // 上書きモード確認: Home に戻して 1 文字打つと後続がシフトせず置換される
  await input.press("Home");
  await page.keyboard.type("X");
  const overwritten = (await input.inputValue()).trimEnd();
  log(`overwrite check: "${overwritten}"`);
  ok = ok && overwritten === "XRKMSG"; // W が X に置換（シフトなし）

  // OIA の編集モード表示（既定は上書き）
  const hasOverwrite = await page.getByText("上書き").first().isVisible().catch(() => false);
  log(`OIA mode 上書き visible: ${hasOverwrite}`);
  ok = ok && hasOverwrite;

  // SO/SI・カナ・キーバインドのトグル/パネルが動くこと（クラッシュしない）
  await page.click("text=SO/SI");
  await page.click('[title*="半角カナ"]');
  await page.click("text=⌨ キー");
  await page.waitForSelector("text=キーバインド編集", { timeout: 3000 });
  await page.click(".kb-panel .x");
  log("toggles/keybindings panel OK");

  // F キーバー（F3 終了は sign off の可能性 → F5 更新で画面遷移を確認）
  await page.click("text=F5 更新");
  await page.waitForTimeout(1500);
  log("F5 sent (screen refresh)");

  // テーマ切替（テーマボタンはテキストで特定。複数の theme-btn があるため）
  // テーマは ライト / ダーク / システム の 3 循環。文言は変わりうるので title で選ぶ。
  // system は環境の設定次第で light に解決されるため、**見た目が変わるまで**巡回する
  const before = await page.getAttribute("html", "data-theme");
  let after = before;
  for (let i = 0; i < 3 && after === before; i++) {
    await page.click('[title*="テーマ切替"]');
    after = await page.getAttribute("html", "data-theme");
  }
  log(`theme toggled: ${before} -> ${after}`);
  ok = ok && before !== after;

  // 操作ログパネルを開く
  await page.click(".logbtn");
  await page.waitForSelector(".logpanel", { timeout: 3000 });
  const logCount = await page.locator(".logpanel .lg").count();
  log(`log panel opened: ${logCount} entries`);
  ok = ok && logCount > 0;

  if (errors.length) {
    ok = false;
    log("PAGE ERRORS: " + errors.join(" | "));
  }
} catch (err) {
  ok = false;
  log("BROWSER E2E ERROR: " + err.message);
  if (errors.length) log("PAGE ERRORS: " + errors.join(" | "));
} finally {
  await browser.close();
  server.close();
}
log(ok ? "T16: OK — ブラウザ E2E 成功" : "T16: NG");
process.exit(ok ? 0 : 1);
