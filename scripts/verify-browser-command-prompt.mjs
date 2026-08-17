// **CL コマンドのプロンプト UI**（F4 相当）を実ブラウザ・実 IBM i で通す。
//
// build 済み web-ui を server で配信し、Playwright で「コマンド入力支援」を開いて
// 定義を引き、欄を埋め、実行して、**ホストのメッセージが返る**ところまで見る。
//
// 実行: node --env-file=.env scripts/verify-browser-command-prompt.mjs
// 必要な環境変数: AS400_HOST / AS400_USER / AS400_PASSWORD
import { serve } from "@hono/node-server";
import { WebSocketServer } from "ws";
import { buildApp, SessionManager, ServerConfigStore, PersonalConfigStore, ConfigResolver } from "@ts5250/server";
import { SecretCrypto } from "../packages/server/dist/secret-crypto.js";
import { chromium } from "playwright";

const log = (s) => process.stderr.write(s + "\n");
const PORT = 3474;
const LIB = "TPLUI";
let ok = true;
const check = (name, cond, detail = "") => {
  log(`${cond ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
  ok = ok && cond;
};

// **パスワードは平文で持たない**——設定は暗号化した形しか受けない（AS400_SECRET_KEY で復号）
const crypto = SecretCrypto.fromEnv();
if (!crypto) {
  log("AS400_SECRET_KEY が要ります（.env）");
  process.exit(1);
}
const resolver = new ConfigResolver(
  new ServerConfigStore(
    {
      systems: [
        {
          id: "i",
          name: "OSAKA",
          host: process.env.AS400_HOST,
          signon: { user: process.env.AS400_USER, passwordEnc: crypto.encrypt(process.env.AS400_PASSWORD) }
        }
      ],
      sessions: []
    },
    crypto
  ),
  new PersonalConfigStore()
);
const app = buildApp({ sessions: new SessionManager(), resolver, version: "t", webRoot: "packages/web-ui/dist" });
const wss = new WebSocketServer({ noServer: true });
const server = serve({ fetch: app.fetch, port: PORT, websocket: { server: wss } });
await new Promise((r) => setTimeout(r, 500));

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1100, height: 800 } });
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
try {
  await page.goto(`http://localhost:${PORT}/`);
  // ランチャーの「コマンド入力支援」カードの「開く」を押す
  await page
    .locator(".fn", { hasText: "コマンド入力支援" })
    .first()
    .locator("button")
    .click();
  await page.waitForSelector('input[placeholder="CRTLIB"]', { timeout: 20000 });

  // 定義を引く
  await page.locator('button:has-text("引く")').click();
  await page.waitForSelector('[data-kwd="LIB"]', { timeout: 30000 });
  const text = await page.evaluate(() => document.body.innerText);
  check("定義が引ける（説明つきで欄が並ぶ）", /Create Library/.test(text));
  check("必須の印が出る", (await page.locator(".req").count()) > 0);
  const opts = await page.locator('select[data-kwd="TYPE"] option').allTextContents();
  check("決まった値は選択肢になる", opts.includes("*PROD") && opts.includes("*TEST"), opts.join("/"));
  check("既定値が脇に出る", /既定 \*PROD/.test(text));

  // 埋める（引用の要る値を入れる）
  await page.fill('[data-kwd="LIB"]', LIB);
  await page.fill('[data-kwd="TEXT"]', "It's a prompt test");
  const preview = await page.locator('[data-testid="preview"]').textContent();
  check("組み上がりが見える", (preview ?? "").startsWith(`CRTLIB LIB(${LIB})`), preview ?? "");

  // **実行前に、走る文字列そのものを確かめられる**（F4 の値打ち）
  await page.locator('button:has-text("確かめる")').click();
  await page.waitForFunction(() => document.body.innerText.includes("サーバーが組んだ文字列"), { timeout: 30000 });
  const exact = await page.locator('[data-testid="preview"]').textContent();
  check("確かめると引用込みの文字列が出る", (exact ?? "").includes("TEXT('It''s a prompt test')"), exact ?? "");

  // 実行
  await page.locator('button:has-text("実行")').click();
  await page.waitForSelector('[data-testid="ran"]', { timeout: 30000 });
  const ran = await page.locator('[data-testid="ran"]').textContent();
  check("走った文字列が返る（引用はサーバーが付ける）", (ran ?? "").includes("TEXT('It''s a prompt test')"), ran ?? "");
  const after = await page.evaluate(() => document.body.innerText);
  check("ホストのメッセージが出る", /CPC2102|成功/.test(after), (after.match(/CPC\d+[^\n]*/) ?? [""])[0]);
  await page.screenshot({ path: "/tmp/claude-1000/-workspaces-ts5250/db6726f4-59da-4ee2-9e11-7de778d4b88d/scratchpad/cmd-prompt.png" });

  check("ページのエラーが出ていない", errors.length === 0, errors.join(" | "));
} catch (e) {
  ok = false;
  log("EXCEPTION: " + (e?.message ?? String(e)));
  await page.screenshot({ path: "/tmp/claude-1000/-workspaces-ts5250/db6726f4-59da-4ee2-9e11-7de778d4b88d/scratchpad/cmd-prompt-fail.png" }).catch(() => {});
} finally {
  // 後片付け（作ったライブラリーを消す）
  await fetch(`http://localhost:${PORT}/api/host/command/run`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ source: { system: "srv:i" }, command: "DLTLIB", values: { LIB } })
  }).catch(() => {});
  await browser.close();
  server.close?.();
}
log(ok ? "\n=> OK" : "\n=> NG");
process.exit(ok ? 0 : 1);
