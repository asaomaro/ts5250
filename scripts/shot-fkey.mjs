// research: 拡張5250（TESTLIB/EXTPGM）の gui 実データと、F キー凡例検出の共存を実機で確認する。
// 実行: node --env-file=.env scripts/research-ext-gui.mjs
import { readFileSync, writeFileSync } from "node:fs";
import { serve } from "@hono/node-server";
import { WebSocketServer } from "ws";
import { buildApp, SessionManager, ServerConfigStore, PersonalConfigStore, ConfigResolver } from "@ts5250/server";
import { SecretCrypto } from "../packages/server/dist/secret-crypto.js";
import { chromium } from "playwright";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (s) => process.stderr.write(s + "\n");
const OUT = "/tmp/ts5250-work";
const PORT = 3509;

const cfg = JSON.parse(readFileSync("connections.json", "utf8"));
writeFileSync(`${OUT}/conn-res.json`, JSON.stringify(cfg));
const crypto = SecretCrypto.fromEnv();
const resolver = new ConfigResolver(
  ServerConfigStore.fromFile(`${OUT}/conn-res.json`, crypto),
  new PersonalConfigStore({ systems: [], sessions: [] }, crypto)
);
const app = buildApp({ sessions: new SessionManager(), resolver, version: "research", webRoot: "packages/web-ui/dist" });
const wss = new WebSocketServer({ noServer: true });
const server = serve({ fetch: app.fetch, port: PORT, websocket: { server: wss } });
await sleep(600);

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1400, height: 860 }, deviceScaleFactor: 2 });
const has = async (t) => (await page.locator("body").innerText()).includes(t);
const shot = async (n) => { await page.screenshot({ path: `${OUT}/${n}` }); log("shot " + n); };
const clickEnter = async () => {
  const b = page.getByText("⏎ 実行", { exact: false }).first();
  if (await b.count()) await b.click(); else await page.keyboard.press("Enter");
};
const type = async (t) => {
  const i = page.locator("input.grid-input:not([readonly])").first();
  await i.click(); await page.keyboard.press("Home");
  await page.keyboard.type(t, { delay: 22 });
};

/**
 * ブラウザ内で現在の snapshot を取り出し、gui と凡例検出の材料を返す。
 *
 * **通しの実行では呼んでいない**（`_` 始まりは lint の未使用許容）。凡例の桁位置や
 * GUI 要素の style を追う必要が出たときに、任意の地点から呼んで
 * `probe-<label>.json` に落とすための道具として残してある。
 */
async function _probe(label) {
  const r = await page.evaluate(() => {
    // sessionsStore は module 内なので DOM から拾う。代わりに __probe を App が晒していない前提で、
    // WebSocket 経由の snapshot は取れないため、DOM から画面テキスト・入力欄・GUI 要素を読む。
    const pane = document.querySelector(".pane");
    if (!pane) return null;
    const rows = [...pane.querySelectorAll(".grid-row")].map((el) => el.textContent ?? "");
    const inputs = [...pane.querySelectorAll("input.grid-input")].map((el) => ({
      ro: el.readOnly, v: el.value, slice: el.dataset.slice, fi: el.dataset.fieldIndex,
    }));
    const guiSel = [...pane.querySelectorAll(".gui-selection")].map((el) => ({
      kind: el.className.replace("gui-selection", "").trim(),
      style: el.getAttribute("style"),
      choices: [...el.querySelectorAll(".gui-choice")].map((c) => ({
        text: c.textContent.trim(),
        selected: c.classList.contains("selected"),
        unavailable: c.classList.contains("unavailable"),
      })),
    }));
    const guiWin = [...pane.querySelectorAll(".gui-window")].map((el) => ({
      style: el.getAttribute("style"),
      title: el.querySelector(".gui-window-title")?.textContent ?? null,
    }));
    const guiBar = [...pane.querySelectorAll(".gui-scrollbar, [class*=scrollbar]")].map((el) => el.className);
    return { rows, inputs, guiSel, guiWin, guiBar };
  });
  if (!r) { log(`--- ${label}: pane なし`); return null; }
  log(`\n########## ${label}`);
  log(`  gui.selectionFields(DOM) = ${r.guiSel.length}  windows = ${r.guiWin.length}  scrollbars = ${r.guiBar.length}`);
  for (const g of r.guiSel) log(`    sel kind=${g.kind} style=${g.style} choices=${JSON.stringify(g.choices)}`);
  for (const w of r.guiWin) log(`    win style=${w.style} title=${JSON.stringify(w.title)}`);
  // 凡例検出（保護セル限定は DOM では厳密に取れないので、まず素のテキストで当てて桁位置を見る）
  const re = /(?<![A-Za-z0-9])(F\d{1,2})\s*=\s*/g;
  r.rows.forEach((line, i) => {
    const found = [];
    let m;
    while ((m = re.exec(line))) found.push(`${m[1]}@${m.index + 1}`);
    if (found.length) log(`    r${i + 1} 凡例: ${found.join(" ")}  |${line.replace(/\s+$/, "")}|`);
  });
  writeFileSync(`${OUT}/probe-${label}.json`, JSON.stringify(r, null, 2));
  return r;
}

try {
  await page.goto(`http://localhost:${PORT}/`);
  await page.waitForSelector(".launcher", { timeout: 20000 });
  await page.click(".card:has-text('実機') >> button:has-text('選択')");
  await page.waitForSelector(".card:has-text('DEV1')", { timeout: 10000 });
  let ok = false;
  for (let a = 1; a <= 8 && !ok; a++) {
    await page.click(".card:has-text('DEV1') >> button:has-text('接続')");
    try { await page.waitForSelector("input.grid-input", { timeout: 15000 }); ok = true; }
    catch { log(`busy ${a}`); await sleep(11000); }
  }
  if (!ok) throw new Error("device busy");
  await sleep(1000);

  for (let i = 0; i < 10; i++) {
    if (await has("メインメニュー")) break;
    if (await has("サイン") && (await page.locator("input.grid-input").count()) >= 2) {
      const inp = page.locator("input.grid-input");
      await inp.nth(0).click(); await page.keyboard.press("Home");
      await inp.nth(0).pressSequentially("USER", { delay: 40 });
      await inp.nth(1).click(); await page.keyboard.press("Home");
      await inp.nth(1).pressSequentially("PASSWORD", { delay: 40 });
      await clickEnter(); await sleep(1500); continue;
    }
    if (await has("対話式ジョブの回復") || await has("中断されました")) { await type("90"); await clickEnter(); await sleep(1500); continue; }
    await clickEnter(); await sleep(1300);
  }
  log("menu reached: " + (await has("メインメニュー")));

  // ボタン設定を「塗り」にする
  // 新 UI: ラベル右の「開く」→ 候補から選ぶ（選んでも閉じない）
  const setBtn = async (label) => {
    await page.locator("button.vsm-btn").first().click(); await sleep(300);
    await shot("ui-1-collapsed.png");
    await page.locator(".vsm-row", { hasText: "ボタン設定" }).first().locator(".vsm-toggle").click();
    await sleep(350);
    await shot("ui-2-expanded.png");
    await page.locator(".pal-item", { hasText: label }).first().click(); await sleep(400);
    log("選択後もメニューは開いたまま: " + (await page.locator(".vsm-menu").count() > 0));
    log("選択後もパレットは開いたまま: " + (await page.locator(".vsm-palette").count() > 0));
    await shot("ui-3-after-pick.png");
    await page.keyboard.press("Escape"); await sleep(500);
  };
  log("凡例ボタン(無効時): " + await page.locator("button.fkey-btn").count());
  await shot("btn-menu-off.png");
  await setBtn("塗り");
  log("凡例ボタン(塗り): " + await page.locator("button.fkey-btn").count());
  const texts = await page.locator("button.fkey-btn").allTextContents();
  log("  → " + texts.map((t) => JSON.stringify(t)).join(" "));
  await shot("btn-menu-on.png");

  // ウィンドウ設定を「影＋スモーク」にする
  await page.locator("button.vsm-btn").first().click(); await sleep(300);
  await page.locator(".vsm-row", { hasText: "ウィンドウ設定" }).first().locator(".vsm-toggle").click(); await sleep(350);
  const secs = await page.locator(".vsm-section").allTextContents();
  log("セクション: " + JSON.stringify(secs));
  await shot("wv-0-palette.png");
  const pals = page.locator(".vsm-palette");
  await pals.nth(0).locator(".pal-item", { hasText: "浮き出し" }).click(); await sleep(250);
  await pals.nth(1).locator(".pal-item", { hasText: "すりガラス" }).click(); await sleep(300);
  await page.keyboard.press("Escape"); await sleep(400);

  // F1 ヘルプ（窓の内側だけボタン化されるか）。**ペインにフォーカスを戻してから**押す。
  await page.locator(".pane").first().click({ position: { x: 400, y: 500 } }); await sleep(400);
  await page.keyboard.press("F1"); await sleep(2600);
  const helpTexts = await page.locator("button.fkey-btn").allTextContents();
  log("ヘルプ窓のボタン: " + helpTexts.length);
  log("  → " + helpTexts.map((t) => JSON.stringify(t)).join(" "));
  log("ヘルプ窓の装飾: deco=" + await page.locator(".win-deco").count() + " smoke=" + await page.locator(".win-smoke").count());
  await shot("wv-1-help.png");
  await page.keyboard.press("F3"); await sleep(1800); // ヘルプを閉じる

  // 実際にボタンを押して AID が飛ぶか（F4=プロンプト。画面が変わるはず）
  await page.locator(".pane").first().click({ position: { x: 400, y: 500 } }); await sleep(300);
  // 画面が確実に変わるキーで検証する（F4=プロンプトは、コマンド欄が空だと何も起きないことがある）
  const before = await page.locator(".grid").first().innerText();
  const target = page.locator("button.fkey-btn", { hasText: "F13=" }).first();
  log("押すボタン: " + (await target.count() ? JSON.stringify(await target.textContent()) : "なし"));
  if (await target.count()) { await target.click(); await sleep(2400); }
  const after = await page.locator(".grid").first().innerText();
  log("クリックで画面が変わった: " + (before !== after ? "はい(OK)" : "いいえ(!)"));

  // 拡張5250 の窓（アプリの WINDOW DSPF）
  await page.keyboard.press("F3"); await sleep(1500);
  await type("ADDLIBLE TESTLIB"); await clickEnter(); await sleep(1200);
  await type("CALL TESTLIB/EXTPGM"); await clickEnter(); await sleep(1600);
  await clickEnter(); await sleep(1800);
  log("拡張5250 の窓の装飾: deco=" + await page.locator(".win-deco").count() + " smoke=" + await page.locator(".win-smoke").count());
  await shot("wv-2-extwindow.png");
  await shot("btn-after-click.png");
} catch (e) {
  log("ERR " + e.message);
  await shot("res-error.png").catch(() => {});
} finally {
  await browser.close();
  server.close();
}
