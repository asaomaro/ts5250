// **カーソル送り（DDS の `FLDCSRPRG` / FCW `0x88nn`）**を実機で確かめる。
//
// ホストが「この欄を出たら画面順の次ではなく nn 番の欄へ」と指定してくる。読み飛ばすと
// **Tab の行き先が実機と違う**——入力の順序をアプリが決めている画面で操作が狂う。
//
// 検証資材は scripts/build-keytest.mjs が作る <LIB>/KEYDSPF ＋ KEYPGM
// （`IN1` に `FLDCSRPRG(IN3)`。実機のワイヤでは欄#1 に `0x8803` が付く）。
//
// 実行:
//   npm run build && npm run build -w @ts5250/web-ui
//   node --env-file=.env --env-file=.env.verify scripts/verify-browser-cursor-progression.mjs
// 任意: SHOT_OUT（画像の出力先。既定 /tmp）
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serve } from "@hono/node-server";
import { WebSocketServer } from "ws";
import { buildApp, SessionManager, ServerConfigStore, PersonalConfigStore, ConfigResolver } from "@ts5250/server";
import { SecretCrypto } from "../packages/server/dist/secret-crypto.js";
import { chromium } from "playwright";

const host = process.env.AS400_HOST;
const user = process.env.AS400_USER;
if (!host || !user || !process.env.AS400_PASSWORD) {
  process.stderr.write("AS400_HOST / AS400_USER / AS400_PASSWORD を環境変数で渡してください\n");
  process.exit(2);
}
const LIB = process.env.AS400_LIB ?? "TESTLIB";
const OUT = process.env.SHOT_OUT ?? tmpdir();
const PORT = Number(process.env.PORT ?? 3498);

// KEYDSPF の位置（build-keytest.mjs と揃える）
const IN1 = { row: 3, col: 30 }, IN2 = { row: 5, col: 30 }, IN3 = { row: 7, col: 30 };
const id = (p) => `f${p.row}c${p.col}`;

const log = (s) => process.stdout.write(s + "\n");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
const check = (cond, msg) => { if (cond) { pass++; log(`  PASS ${msg}`); } else { fail++; log(`  FAIL ${msg}`); } };

const work = mkdtempSync(join(tmpdir(), "csrprg-"));
const cfgPath = join(work, "profiles.json");
writeFileSync(
  cfgPath,
  JSON.stringify({
    systems: [{ id: "AS400", name: "AS400", host, ccsid: 930, signon: { user, passwordEnv: "AS400_PASSWORD" } }],
    sessions: [{ id: "DSP", name: "DSP", system: "AS400", sessionType: "display", screenSize: "24x80" }]
  })
);
const crypto = SecretCrypto.fromEnv();
const resolver = new ConfigResolver(
  ServerConfigStore.fromFile(cfgPath, crypto),
  new PersonalConfigStore({ systems: [], sessions: [] }, crypto)
);
const app = buildApp({ sessions: new SessionManager(), resolver, version: "verify", webRoot: "packages/web-ui/dist" });
const wss = new WebSocketServer({ noServer: true });
const server = serve({ fetch: app.fetch, port: PORT, websocket: { server: wss } });
await sleep(600);

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1400, height: 900 }, deviceScaleFactor: 2 });
const sel = (p) => `input.grid-input[data-field="${id(p)}"]`;
const focusedField = () => page.evaluate(() => document.activeElement?.getAttribute?.("data-field") ?? undefined);
async function focusAt(p) {
  const el = page.locator(sel(p));
  await el.click();
  await el.evaluate((e) => e.setSelectionRange(0, 0));
  await sleep(120);
}

try {
  await page.goto(`http://localhost:${PORT}/`);
  await page.waitForSelector(".launcher", { timeout: 20000 });
  if ((await page.locator(".card:has-text('DSP')").count()) === 0) {
    await page.click(".card:has-text('AS400') >> button:has-text('選択')");
    await page.waitForSelector(".card:has-text('DSP')", { timeout: 10000 });
  }
  let opened = false;
  for (let a = 1; a <= 6 && !opened; a++) {
    await page.click(".card:has-text('DSP') >> button:has-text('接続')");
    try { await page.waitForSelector("input.grid-input", { timeout: 20000 }); opened = true; }
    catch { log(`  （装置が空くのを待つ ${a}）`); await sleep(9000); }
  }
  check(opened, "実機へ接続して画面が出る");
  if (!opened) throw new Error("接続できない");
  await sleep(1200);

  for (let i = 0; i < 8; i++) {
    const t = await page.locator(".pane").innerText();
    if (t.includes("コマンドを入力") || t.includes("選択項目またはコマンド")) break;
    if (t.includes("サイン・オン")) {
      await page.keyboard.type(user);
      await page.keyboard.press("Tab");
      await page.keyboard.type(process.env.AS400_PASSWORD);
    } else if (t.includes("回復")) {
      await page.keyboard.type("90");
    }
    await page.keyboard.press("Enter");
    await sleep(2500);
  }

  await page.keyboard.type(`CALL ${LIB}/KEYPGM`);
  await page.keyboard.press("Enter");
  await sleep(3000);
  check((await page.locator(".pane").innerText()).includes("KEYPGM AID/CURSOR TEST"), "KEYPGM のテスト画面が出ている");

  // --- ① Tab: IN1（FLDCSRPRG(IN3)）→ IN3 ---
  log("\n### ① Tab（IN1 は FLDCSRPRG(IN3)）");
  await focusAt(IN1);
  await page.keyboard.press("Tab");
  await sleep(250);
  const t1 = await focusedField();
  log(`  IN1 で Tab → ${t1}（期待 ${id(IN3)}・画面順の次は ${id(IN2)}）`);
  check(t1 === id(IN3), `指定された欄へ飛ぶ（実際 ${t1}）`);

  // --- ② Tab: 指定の無い欄は画面順どおり ---
  log("\n### ② Tab（指定の無い IN2）");
  await focusAt(IN2);
  await page.keyboard.press("Tab");
  await sleep(250);
  const t2 = await focusedField();
  log(`  IN2 で Tab → ${t2}（期待 ${id(IN3)}）`);
  check(t2 === id(IN3), `画面順の次へ行く（実際 ${t2}）`);

  // --- ③ 満杯の自動送りでも指定先へ ---
  log("\n### ③ 欄が満杯になったときの自動送り");
  await focusAt(IN1);
  await page.keyboard.type("ABCDE", { delay: 30 });
  await sleep(300);
  const t3 = await focusedField();
  log(`  IN1 を 5 桁埋める → ${t3}（期待 ${id(IN3)}）`);
  check(t3 === id(IN3), `満杯の自動送りも指定先へ行く（実際 ${t3}）`);

  const shot = join(OUT, "cursor-progression.png");
  await page.locator(".pane").screenshot({ path: shot });
  log(`  画像: ${shot}`);

  await page.keyboard.press("F3");
  await sleep(1500);
} catch (err) {
  check(false, err instanceof Error ? err.message : String(err));
} finally {
  await browser.close();
  await new Promise((r) => server.close(r));
  rmSync(work, { recursive: true, force: true });
}

log(`\n${fail === 0 ? "すべて PASS" : `FAIL ${fail} 件`}（PASS ${pass}）`);
process.exit(fail === 0 ? 0 : 1);
