// **ブラウザから 3270 端末を触る E2E。**
//
// build 済み web-ui を server で配信し、Playwright で
// 「端末の種類＝3270」のセッション設定に接続 → 画面が描かれる → 入力欄に打って Enter →
// ホストの応答が返る、までを実ブラウザで通す。
//
// **相手は選べる**（3270 を受けるホストなら何でもよい）:
//   既定  = ローカルの TK4-（MVS 3.8j）。先に起動しておく:
//           sh packages/tn3270/test/harness/testenv.sh up
//   IBM i = TN3270_HOST=pub400.com TN3270_CCSID=37 node --env-file=.env scripts/verify-browser-3270.mjs
//
// **メインフレームだけで確かめない**——このライブラリの主な接続先は IBM i で、
// あちらは 5250 の世界を 3270 へ橋渡しする（画面の作りが違う）。実行: node scripts/verify-browser-3270.mjs
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
const HOST = process.env.TN3270_HOST ?? process.env.TK4_HOST ?? "127.0.0.1";
const TK4_PORT = Number(process.env.TN3270_PORT ?? process.env.TK4_PORT ?? (process.env.TN3270_HOST ? 23 : 3270));
const CCSID = Number(process.env.TN3270_CCSID ?? 37);
const NAME = process.env.TN3270_NAME ?? (process.env.TN3270_HOST ? "IBM i 3270" : "TK4- 3270");
/** ホストごとの「画面が出た」印。IBM i はサインオン画面、TK4- は起動画面 */
const MARK =
  process.env.TN3270_MARK ??
  (process.env.TN3270_HOST ? "IBM i|Sign On|サインオン|user name|ユーザー" : "MVS 3\\.8j");

// **3270 のセッション設定を 1 つだけ持つサーバー**を組み立てる
const resolver = new ConfigResolver(
  new ServerConfigStore({
    systems: [{ id: "mf", name: NAME, host: HOST, port: TK4_PORT, ccsid: CCSID }],
    sessions: [
      { id: "s3270", name: NAME, system: "mf", sessionType: "display", terminal: "3270", model3270: 2 }
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
const sentFrames = [];
page.on("websocket", (ws) => {
  ws.on("framereceived", (f) => frames.push(f.payload));
  ws.on("framesent", (f) => sentFrames.push(f.payload));
  ws.on("close", () => log("WS closed"));
  ws.on("socketerror", (e) => log("WS socketerror: " + e));
  log("WS 接続: " + ws.url());
});
let ok = true;
const check = (name, cond, detail = "") => {
  log(`${cond ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
  ok = ok && cond;
};

try {
  // **ブラウザ内で WebSocket を包んで数える**（Playwright の frame 監視と突き合わせる）
  await page.addInitScript(() => {
    window.__wsLog = [];
    const Orig = window.WebSocket;
    // **クラスで包む**——関数で包むと `new` の扱いが変わってアプリが繋がらなくなる（実際に踏んだ）
    class Wrapped extends Orig {
      constructor(...args) {
        super(...args);
        this.addEventListener("message", (e) => {
          const s = typeof e.data === "string" ? e.data : "";
          window.__wsLog.push({ len: s.length, type: (s.match(/"type":"(\w+)"/) ?? [])[1] });
        });
      }
    }
    window.WebSocket = Wrapped;
  });
  await page.goto(`http://localhost:${PORT}/`);
  await page.locator(".card", { hasText: NAME }).first().locator("button", { hasText: "接続" }).click();
  // **中身が来るまで待つ**——桁数だけ見ると、空の 24x80 でも条件を満たしてしまう
  // （3270 は文字が `<input>` の value に入るので `textContent` は空白のまま）。
  await page.waitForFunction(
    (mark) => {
      const g = document.querySelector(".grid");
      if (!g) return false;
      const values = [...g.querySelectorAll("input")].map((i) => i.value).join("\n");
      return new RegExp(mark).test((g.innerText ?? "") + "\n" + values);
    },
    MARK,
    { timeout: 30000 }
  );
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
  check(
    "3270 ホストの画面が描かれる",
    new RegExp(MARK).test(screen),
    (screen.split("\n").find((l) => new RegExp(MARK).test(l)) ?? "").trim().slice(0, 60)
  );
  const bodyText = await page.evaluate(() => document.body.innerText);
  check("状態表示に画面サイズが出る", /24x80/.test(bodyText));
  await page.screenshot({ path: "/tmp/claude-1000/-workspaces-ts5250/db6726f4-59da-4ee2-9e11-7de778d4b88d/scratchpad/3270-welcome.png" });

  // 入力欄（Logon ===>）に打って Enter
  const inputs = page.locator("input.grid-input:not([readonly])");
  const n = await inputs.count();
  check("入力欄が描かれている", n >= 1, `${n} 個`);
  await inputs.first().click();
  await page.keyboard.type("HELP");
  const beforeText = await screenText();
  check("打った文字が入力欄に入る", /HELP/.test(beforeText));
  await page.keyboard.press("Enter");
  await page.waitForTimeout(3500);
  const after = await screenText();
  // **画面が変わったこと**をホスト応答の印にする（応答文はホストごとに違う）
  check("Enter でホストが応答し画面が変わる", after !== beforeText, (after.split("\n").find((l) => l.trim()) ?? "").trim().slice(0, 60));
  await page.screenshot({ path: "/tmp/claude-1000/-workspaces-ts5250/db6726f4-59da-4ee2-9e11-7de778d4b88d/scratchpad/3270-after-key.png" });

  // **ファンクションキーが実際にホストへ届くか**（例外が出ないだけでは足りない）
  const beforeF = await screenText();
  const framesBeforeF = frames.length;
  await page.keyboard.press("F3");
  await page.waitForTimeout(3000);
  const wsErr = frames.slice(framesBeforeF).map((f) => { try { return JSON.parse(f); } catch { return null; } })
    .filter((m) => m && m.type === "error");
  check("F3 で WS エラーが出ない", wsErr.length === 0, wsErr.map((e) => `${e.code}:${e.message}`).join(" | "));
  check("F3 でホストが応答する", (await screenText()) !== beforeF);
  // PageDown / PageUp
  const framesBeforeP = frames.length;
  await page.keyboard.press("PageDown");
  await page.waitForTimeout(3000);
  const wsErrP = frames.slice(framesBeforeP).map((f) => { try { return JSON.parse(f); } catch { return null; } })
    .filter((m) => m && m.type === "error");
  check("PageDown で WS エラーが出ない", wsErrP.length === 0, wsErrP.map((e) => `${e.code}:${e.message}`).join(" | "));
  // **PageDown は 3270 では F8 として出る**（実測: IBM i はこれでページ送りする）
  const pageSent = sentFrames.map((f) => { try { return JSON.parse(f); } catch { return null; } })
    .filter((m) => m && m.type === "key").pop();
  check("PageDown が F8 として送られる", pageSent?.key === "F8", JSON.stringify(pageSent?.key));
  check("ページのエラーが出ていない", errors.length === 0, errors.join(" | "));
} catch (e) {
  ok = false;
  log("EXCEPTION: " + (e?.message ?? String(e)));
  await page.screenshot({ path: "/tmp/claude-1000/-workspaces-ts5250/db6726f4-59da-4ee2-9e11-7de778d4b88d/scratchpad/3270-fail.png" }).catch(() => {});
  // **何が届いていたか**を出す（届いていないのか、描けていないのかの切り分け）
  const kinds = frames.map((f) => { try { return JSON.parse(f).type; } catch { return "?"; } });
  log("WS 受信: " + JSON.stringify(kinds));
  log("ブラウザ内で数えた受信: " + JSON.stringify(await page.evaluate(() => window.__wsLog ?? "hook 無効")));
  log("WS 送信: " + JSON.stringify(sentFrames.map((f) => { try { const m = JSON.parse(f); return m.type; } catch { return "?"; } })));
  log("WS 送信(open): " + (sentFrames.find((f) => f.includes("\"open\"")) ?? "なし").slice(0, 200));
  const last = frames.map((f) => { try { return JSON.parse(f); } catch { return null; } })
    .filter((m) => m && (m.type === "screen" || m.type === "opened")).pop();
  if (last) {
    const rows = last.screen.cells.map((r) => r.map((c) => (c.kind === "dbcs-tail" ? "" : c.char)).join("").replace(/\s+$/, ""));
    log("最後に届いた画面（空でない行）:");
    rows.forEach((r, i) => { if (r.trim()) log(String(i + 1).padStart(2) + "|" + r); });
    log("欄の数: " + last.screen.fields.length + " / 非保護 " + last.screen.fields.filter((f) => !f.protected).length);
  }
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
