// **IBM i に VT で繋ぐところを実ブラウザで通す。**
//
// `verify-browser-vt.mjs` は Linux 相手（実アプリの語彙が厳しい側）。こちらは IBM i 相手で、
// **コードページの申告**（NEW-ENVIRON）が UI 経路でも効いているかを見る。
//
// ⚠ **ホストによっては画面が来ない**（実機。`scripts/README.md` の VT 節）。
// ⚠ **サインオンの失敗は QMAXSIGN に数えられる**（pub400=5 / 実機=3）。試行を重ねない。
//
// 実行: node --env-file=.env scripts/verify-browser-vt-ibmi.mjs
import { serve } from "@hono/node-server";
import { WebSocketServer } from "ws";
import { buildApp, SessionManager, ServerConfigStore, PersonalConfigStore, ConfigResolver } from "@ts5250/server";
import { SecretCrypto } from "../packages/server/dist/secret-crypto.js";
import { chromium } from "playwright";

const log = (s) => process.stderr.write(s + "\n");
const PORT = 3481;
const NAME = "VT-IBMI";
const SHOT = "/tmp/claude-1000/-workspaces-ts5250/db6726f4-59da-4ee2-9e11-7de778d4b88d/scratchpad";
const PRE = process.env.PROBE === "AS400" ? "AS400" : "PUB400";
let ok = true;
const check = (name, cond, detail = "") => {
  log(`${cond ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
  ok = ok && cond;
};

const crypto = SecretCrypto.fromEnv();
if (!crypto) { log("AS400_SECRET_KEY が要ります（.env）"); process.exit(1); }
const host = process.env[`${PRE}_HOST`];
const user = process.env[`${PRE}_USER`];
const password = process.env[`${PRE}_PASSWORD`];
if (!host || !user || !password) { log(`${PRE}_HOST / _USER / _PASSWORD が要ります`); process.exit(2); }

const resolver = new ConfigResolver(
  new ServerConfigStore(
    {
      // **CCSID を持たせる**——これが NEW-ENVIRON の KBDTYPE/CODEPAGE/CHARSET になる。
      // 申告しないと記号入りのパスワードが化けて CPF1120 で落ちる
      systems: [{ id: "i", name: PRE, host, ccsid: PRE === "PUB400" ? 37 : 930 }],
      sessions: [{ id: "svt", name: NAME, system: "i", sessionType: "display", terminal: "vt", vtEncoding: "utf-8" }]
    },
    crypto
  ),
  new PersonalConfigStore()
);
const app = buildApp({ sessions: new SessionManager(), resolver, version: "test", webRoot: "packages/web-ui/dist" });
const wss = new WebSocketServer({ noServer: true });
const server = serve({ fetch: app.fetch, port: PORT, websocket: { server: wss } });
await new Promise((r) => setTimeout(r, 500));

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1200, height: 820 } });
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
const screen = () => page.locator(".vt-pane").innerText();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

try {
  await page.goto(`http://localhost:${PORT}/`);
  await page.locator(".card", { hasText: NAME }).first().locator("button", { hasText: "接続" }).click();
  await page.waitForSelector(".vt-pane", { timeout: 25000 });
  await sleep(5000);

  const signon = await screen();
  if (!/Sign On|サインオン|user name|ユーザー|User/iu.test(signon)) {
    log("\n  ⚠ **サインオン画面が来ていない。** ホスト側で VT の仮想装置にジョブが");
    log("     割り当てられていない可能性がある（QSYSOPR の CPF1194。scripts/README.md）");
    check("サインオン画面が届く", false, signon.slice(0, 80));
    throw new Error("画面が来ない");
  }
  check("サインオン画面が届く", true);
  check("仮想装置が割り当たっている", /QPADEV|Display name|表示装置/iu.test(signon));

  log("\n[2] サインオン（**失敗は QMAXSIGN に数えられる**ので 1 回だけ）");
  await page.locator(".vt-pane").focus();
  await page.keyboard.type(user, { delay: 40 });
  await sleep(500);
  await page.keyboard.press("Tab");
  await sleep(900);
  await page.keyboard.type(password, { delay: 40 });
  await sleep(500);
  await page.keyboard.press("Enter");
  await sleep(8000);
  let after = await screen();
  if (/Press Enter|継続するには/iu.test(after)) {
    await page.keyboard.press("Enter");
    await sleep(4000);
    after = await screen();
  }
  check("**CPF1120 が出ない**（コードページの申告が UI 経路でも効いている）", !/CPF1120/u.test(after),
    (after.match(/CPF\d+[^\n]*/) ?? [""])[0]);
  check("IBM i のメインメニューに到達した", /Main Menu|メインメニュー|MAIN/u.test(after),
    after.split("\n").find((l) => l.trim()) ?? "");

  log("\n[3] コマンドを打つ");
  await page.keyboard.type("DSPLIBL", { delay: 40 });
  await sleep(400);
  await page.keyboard.press("Enter");
  await sleep(6000);
  check("DSPLIBL が実行できた", /Library List|ライブラリー・リスト|QSYS/iu.test(await screen()));
  await page.keyboard.press("F3");
  await sleep(3000);

  await page.screenshot({ path: `${SHOT}/vt-browser-ibmi.png` });
  check("ページのエラーが出ていない", errors.length === 0, errors.join(" | "));

  log("\n[4] サインオフ");
  await page.keyboard.type("SIGNOFF", { delay: 40 });
  await page.keyboard.press("Enter");
  await sleep(2500);
} catch (e) {
  ok = false;
  log("EXCEPTION: " + (e?.message ?? String(e)));
  await page.screenshot({ path: `${SHOT}/vt-browser-ibmi-fail.png` }).catch(() => {});
} finally {
  await browser.close();
  server.close?.();
}
log(ok ? "\n=> OK" : "\n=> NG");
process.exit(ok ? 0 : 1);
