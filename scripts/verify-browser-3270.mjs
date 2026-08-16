// **ブラウザから 3270 端末を触る E2E。**
//
// build 済み web-ui を server で配信し、Playwright で
// 「端末の種類＝3270」のセッション設定に接続 → 画面が描かれる → 入力欄に打って Enter →
// ホストの応答が返る、までを実ブラウザで通す。
//
// 相手は**ローカルの TK4-（MVS 3.8j）**。事前に起動しておくこと:
//   sh packages/tn3270/test/harness/testenv.sh up
// 実行: node scripts/verify-browser-3270.mjs
import { serve } from "@hono/node-server";
import { WebSocketServer } from "ws";
import {
  buildApp,
  SessionManager,
  ServerConfigStore,
  PersonalConfigStore,
  ConfigResolver
} from "@ts5250/server";
import { chromium } from "playwright";

const log = (s) => process.stderr.write(s + "\n");
const PORT = 3468;
const HOST = process.env.TK4_HOST ?? "127.0.0.1";
const TK4_PORT = Number(process.env.TK4_PORT ?? 3270);

// **3270 のセッション設定を 1 つだけ持つサーバー**を組み立てる
const resolver = new ConfigResolver(
  new ServerConfigStore({
    systems: [{ id: "mf", name: "TK4-", host: HOST, port: TK4_PORT }],
    sessions: [
      { id: "s3270", name: "TK4- 3270", system: "mf", sessionType: "display", terminal: "3270", model3270: 2 }
    ]
  }),
  new PersonalConfigStore()
);
const app = buildApp({
  sessions: new SessionManager(),
  resolver,
  version: "test",
  webRoot: "packages/web-ui/dist"
});
const wss = new WebSocketServer({ noServer: true });
const server = serve({ fetch: app.fetch, port: PORT, websocket: { server: wss } });
await new Promise((r) => setTimeout(r, 500));

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1100, height: 760 } });
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
// **ブラウザが実際に受け取った WS フレーム**を覗く（描画の食い違いを切り分けるため）
const frames = [];
page.on("websocket", (ws) => ws.on("framereceived", (f) => frames.push(f.payload)));
let ok = true;
const check = (name, cond, detail = "") => {
  log(`${cond ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
  ok = ok && cond;
};

try {
  await page.goto(`http://localhost:${PORT}/`);
  await page.locator(".card", { hasText: "TK4- 3270" }).first().locator("button", { hasText: "接続" }).click();
  await page.waitForFunction(() => (document.querySelector(".grid")?.textContent?.length ?? 0) > 100, {
    timeout: 25000
  });
  /**
   * **画面の文字を読む。**
   *
   * 3270 は**画面全体が欄になる**ため、UI は文字を `<input>` の value に入れて描く
   * （5250 は定数部分が欄でないのでテキストとして出る）。
   * `innerText` だけ見ると**真っ白に見える**——最初これで誤検知した。
   */
  const screenText = () =>
    page.evaluate(() => {
      const grid = document.querySelector(".grid");
      const text = grid.innerText ?? "";
      const values = [...grid.querySelectorAll("input")].map((i) => i.value).join("\n");
      return text + "\n" + values;
    });
  const screen = await screenText();
  const errFrames = frames.map((f) => { try { return JSON.parse(f); } catch { return null; } })
    .filter((m) => m && m.type === "error");
  check("WS にエラーが流れていない", errFrames.length === 0, errFrames.map((e) => `${e.code}:${e.message}`).join(" | "));
  check("3270 ホストの画面が描かれる", /MVS 3\.8j/.test(screen), screen.split("\n").find((l) => /MVS/.test(l))?.trim());
  const bodyText = await page.evaluate(() => document.body.innerText);
  check("状態表示に画面サイズが出る", /24x80/.test(bodyText));
  await page.screenshot({ path: "/tmp/claude-1000/-workspaces-ts5250/db6726f4-59da-4ee2-9e11-7de778d4b88d/scratchpad/3270-welcome.png" });

  // 入力欄（Logon ===>）に打って Enter
  const inputs = page.locator("input.grid-input:not([readonly])");
  const n = await inputs.count();
  check("入力欄が描かれている", n >= 1, `${n} 個`);
  await inputs.first().click();
  await page.keyboard.type("HELP");
  await page.keyboard.press("Enter");
  await page.waitForTimeout(3000);
  const after = await screenText();
  check("打った文字がホストへ届き応答が返る", /IKJ56420I/.test(after), (after.match(/IKJ\S+[^\n]*/) ?? [""])[0]);
  await page.screenshot({ path: "/tmp/claude-1000/-workspaces-ts5250/db6726f4-59da-4ee2-9e11-7de778d4b88d/scratchpad/3270-after-key.png" });

  // ファンクションキー（3270 の PF）が送れる
  await page.keyboard.press("F3");
  await page.waitForTimeout(2000);
  check("PF キーで例外が出ない", errors.length === 0, errors.join(" | "));
} catch (e) {
  ok = false;
  log("EXCEPTION: " + (e?.message ?? String(e)));
} finally {
  if (errors.length) {
    ok = false;
    log("PAGE ERRORS: " + errors.join(" | "));
  }
  await browser.close();
  server.close?.();
}
log(ok ? "\n=> OK" : "\n=> NG");
process.exit(ok ? 0 : 1);
