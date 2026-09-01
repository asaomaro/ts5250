// 「上で入力 → Enter → 上がプロテクト、下が展開」の画面で、**展開した下の入力欄に
// フォーカスが自動で付くか**をブラウザごと確かめる（利用者報告の再現・修正の確認）。
//
// 核（`Session5250`）はホストの `DSPATR(PC)` に追従できている（`diag-cursor-after-expand.mjs`
// で 10/12 を確認済み）。だから見るべきは **DOM のフォーカス**。
//
// 検証資材は scripts/build-cursortst.mjs が作る <LIB>/CURSORCL。
//
// 実行:
//   npm run build && npm run build -w @ts5250/web-ui
//   node --env-file=.env --env-file=.env.verify scripts/verify-browser-focus-after-expand.mjs
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
const PORT = Number(process.env.PORT ?? 3497);

// CURSORTST の位置（build-cursortst.mjs と揃える）
const CODE = { row: 3, col: 12 }, NAME = { row: 10, col: 12 };
const id = (p) => `f${p.row}c${p.col}`;

const log = (s) => process.stdout.write(s + "\n");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
const check = (cond, msg) => { if (cond) { pass++; log(`  PASS ${msg}`); } else { fail++; log(`  FAIL ${msg}`); } };

const work = mkdtempSync(join(tmpdir(), "expfocus-"));
const cfgPath = join(work, "profiles.json");
writeFileSync(
  cfgPath,
  JSON.stringify({
    systems: [{ id: "AS400", name: "AS400", host, ccsid: 5035, signon: { user, passwordEnv: "AS400_PASSWORD" } }],
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
const focusedField = () => page.evaluate(() => document.activeElement?.getAttribute?.("data-field") ?? document.activeElement?.className ?? "(なし)");

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

  await page.keyboard.type(`CALL ${LIB}/${process.env.PGM ?? "CURSORCL"}`);
  await page.keyboard.press("Enter");
  await sleep(3000);
  check(/EXPAND\/PROTECT|NO PC ATTR|PC ON PROTECTED/.test(await page.locator(".pane").innerText()), "テスト画面が出ている");

  log("\n### 1 画面目（上だけ入力可）");
  const f1 = await focusedField();
  log(`  フォーカス: ${f1}（期待 ${id(CODE)}）`);
  check(f1 === id(CODE), `上の入力欄にフォーカスが付く（実際 ${f1}）`);

  log("\n### Enter → 2 画面目（上プロテクト・下が展開）");
  await page.keyboard.type("ABC123");
  await page.keyboard.press("Enter");
  await sleep(3500);
  const t2 = await page.locator(".pane").innerText();
  check(t2.includes("DETAIL"), "下が展開している");
  const f2 = await focusedField();
  log(`  フォーカス: ${f2}（期待 ${id(NAME)}＝ホストが DSPATR(PC) で指した欄）`);
  check(f2 === id(NAME), `展開した下の入力欄にフォーカスが付く（実際 ${f2}）`);

  // 打った文字がどこへ入るかまで見る（フォーカスが無いと 1 文字も入らない）
  await page.keyboard.type("X");
  await sleep(400);
  const typed = await page.evaluate(() => document.activeElement?.value ?? "");
  log(`  1 文字打った結果: "${typed}"`);
  check(typed.startsWith("X"), "打鍵が下の欄に入る");

  const shot = join(OUT, "focus-after-expand.png");
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
