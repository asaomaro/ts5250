// **VT のセッションを実ブラウザで通す。**
//
// build 済み web-ui を server で配信し、Playwright で VT のセッションを開いて
// シェルを実際に使う——コマンドの往復・色・日本語・`vi` の代替画面・履歴・リサイズ。
//
// 準備:
//   docker build -t ts5250-vt-telnetd scripts/vt-telnetd
//   docker run -d --name ts5250-vt -p 2331:23 ts5250-vt-telnetd
//   npm run build -w @ts5250/web-ui
// 実行:
//   node scripts/verify-browser-vt.mjs
//
// ⚠ **画面の文字は `innerText` で取れる**（VT は span で描くため）。
// 3270 / 5250 は `<input>` の value に入るので取れない——**ペインごとに違う**。
import { serve } from "@hono/node-server";
import { WebSocketServer } from "ws";
import { buildApp, SessionManager, ServerConfigStore, PersonalConfigStore, ConfigResolver } from "@ts5250/server";
import { chromium } from "playwright";

const log = (s) => process.stderr.write(s + "\n");
const PORT = 3479;
const NAME = "VT-LINUX";
const VT_PORT = Number(process.env.VT_PORT ?? 2331);
const SHOT = "/tmp/claude-1000/-workspaces-ts5250/db6726f4-59da-4ee2-9e11-7de778d4b88d/scratchpad";
let ok = true;
const check = (name, cond, detail = "") => {
  log(`${cond ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
  ok = ok && cond;
};

const resolver = new ConfigResolver(
  new ServerConfigStore({
    systems: [{ id: "lx", name: "LINUX", host: "127.0.0.1", port: VT_PORT }],
    sessions: [
      { id: "svt", name: NAME, system: "lx", sessionType: "display", terminal: "vt", vtEncoding: "utf-8" }
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
const page = await browser.newPage({ viewport: { width: 1200, height: 820 } });
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));

const screen = () => page.locator(".vt-pane").innerText();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** 打つ。**ペインにフォーカスがある前提**（キーはペインが拾う） */
const type = async (text, wait = 700) => {
  await page.locator(".vt-pane").focus();
  await page.keyboard.type(text);
  await sleep(wait);
};
const enter = async (wait = 900) => {
  await page.keyboard.press("Enter");
  await sleep(wait);
};

try {
  await page.goto(`http://localhost:${PORT}/`);
  await page.locator(".card", { hasText: NAME }).first().locator("button", { hasText: "接続" }).click();
  await page.waitForSelector(".vt-pane", { timeout: 20000 });
  await sleep(1500);

  log("\n[1] ペインが出る");
  check("VT の専用ペインが描かれる", (await page.locator(".vt-pane").count()) === 1);
  check("5250 の CRT ペインは出ない", (await page.locator(".grid").count()) === 0);
  check("ホストのプロンプトが見える", /[#$]/.test(await screen()), (await screen()).split("\n")[0]);
  // **交渉が終われば案内は消える**（開いた直後の値を握ったままにしない）
  check("エコーの案内が残っていない", !(await screen()).includes("エコーを返していません"));

  log("\n[2] コマンドの往復");
  await type("export PS1='$ '; stty -echo; clear");
  await enter();
  await type("echo HELLO-FROM-BROWSER");
  await enter();
  check("打った文字がホストへ届き、結果が返る", (await screen()).includes("HELLO-FROM-BROWSER"));

  log("\n[3] 大きさがペインから決まる（NAWS）");
  await type("stty size");
  await enter();
  const size = (await screen()).match(/(\d+) (\d+)/);
  check("ホストが桁・行を知っている", size !== null, size ? size[0] : "取れず");
  check("**80 桁固定ではない**（ペインの寸法から決まっている）", size !== null && Number(size[2]) !== 80, size ? size[2] + " 桁" : "");

  log("\n[4] 色");
  await type("clear; printf '\\033[38;5;208mORANGE\\033[0m \\033[1;4mBOLDUL\\033[0m\\n'");
  await enter();
  const styled = await page.locator(".vt-pane span[style*='rgb(255, 135, 0)']").count();
  check("256 色が色として出る", styled > 0);
  const bold = await page.locator(".vt-pane span[style*='font-weight: bold']").count();
  check("太字・下線が出る", bold > 0);

  log("\n[5] 日本語");
  await type("clear; printf '\\343\\201\\202\\343\\201\\204|X\\n'");
  await enter();
  check("全角が出る", (await screen()).includes("あい"));
  // 桁がずれていないことは「|X」がその直後に並ぶかで見る
  check("全角のあとの桁がずれない", /あい\|X/.test(await screen()), (await screen()).match(/あ.*/)?.[0] ?? "");

  log("\n[6] 日本語を打つ（IME の確定に相当）");
  await page.locator(".vt-pane").focus();
  await page.evaluate(() => {
    const el = document.querySelector(".vt-pane");
    el.dispatchEvent(new CompositionEvent("compositionstart"));
    el.dispatchEvent(new CompositionEvent("compositionend", { data: "echo 日本語入力" }));
  });
  await sleep(600);
  await enter();
  check("**打った日本語がホストのエコーで返る**", (await screen()).includes("日本語入力"));

  log("\n[7] vi（代替画面）");
  await type("clear; echo MAIN-SCREEN-MARK");
  await enter();
  await type("vi /etc/hostname", 300);
  await enter(2200);
  const inVi = await screen();
  check("代替画面に入る（主画面の内容が消える）", !inVi.includes("MAIN-SCREEN-MARK"));
  await page.keyboard.press("Escape");
  await sleep(200);
  await type(":q!", 200);
  await enter(1800);
  check("**抜けると主画面が戻る**", (await screen()).includes("MAIN-SCREEN-MARK"));

  log("\n[8] 履歴を遡れる");
  await type("clear; seq 1 200", 300);
  await enter(2500);
  const tail = await screen();
  check("最後まで流れて追いついている", tail.includes("200"));
  await page.locator(".vt-scroll").evaluate((el) => { el.scrollTop = 0; });
  await sleep(400);
  const top = await screen();
  check("**遡ると古い行が見える**", top.includes("1\n2\n3") || /(^|\n)1(\n|$)/.test(top));

  log("\n[9] ペインを広げるとホストへ伝わる");
  await page.setViewportSize({ width: 1500, height: 900 });
  await sleep(900);
  await page.locator(".vt-scroll").evaluate((el) => { el.scrollTop = el.scrollHeight; });
  await type("clear; stty size", 300);
  await enter(1200);
  const size2 = (await screen()).match(/(\d+) (\d+)/);
  check("**広げたら桁が増える**", size2 !== null && size !== null && Number(size2[2]) > Number(size[2]),
    `${size?.[2]} → ${size2?.[2]}`);

  log("\n[10] 種別の表記と、出さないもの（spec D9）");
  const body = await page.evaluate(() => document.body.innerText);
  check("VT 端末として扱われている", /VT/.test(body));
  // **5250 の道具は出さない。** どれもフィールドモデルの上に建っていて VT には無い
  // ——出すと「押しても何も起きない」で混乱させる
  check("キーの一覧を出さない", !/⌨ キー/.test(body));
  check("HTML 保存を出さない", !/⬇ HTML/.test(body));
  check("マクロを出さない", !/マクロ/.test(body));

  await page.screenshot({ path: `${SHOT}/vt-browser.png` });
  check("ページのエラーが出ていない", errors.length === 0, errors.join(" | "));
} catch (e) {
  ok = false;
  log("EXCEPTION: " + (e?.message ?? String(e)));
  await page.screenshot({ path: `${SHOT}/vt-browser-fail.png` }).catch(() => {});
} finally {
  await browser.close();
  server.close?.();
}
log(ok ? "\n=> OK" : "\n=> NG");
process.exit(ok ? 0 : 1);
