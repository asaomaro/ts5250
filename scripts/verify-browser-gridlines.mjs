// **罫線が実ブラウザの画面にも出ているか**を実機で確かめる（S9R167D の再現画面）。
//
// `verify-gridlines-clear-unit.mjs` は画面バッファ（snapshot.gui.gridLines）までを見る。
// こちらは**その先**——web-ui が `.grid-line` を実際に描いているかを DOM と画像で見る。
// 画面バッファに残っていても描画側で落ちていれば利用者には「罫線が出ない」ままなので、
// 両方を見て初めて「直った」と言える。
//
// 検証資材は scripts/build-gridtest6.mjs が作る <LIB>/GRIDTST6 ＋ GRIDCL8 / GRIDCL9。
//   GRIDCL8 … 罫線 → OVERLAY 無し（ホストが素の CLEAR UNIT を挟む＝症状の経路）
//   GRIDCL9 … 罫線 → OVERLAY 付き（対照）
//
// 実行:
//   npm run build && npm run build -w @ts5250/web-ui
//   node --env-file=.env --env-file=.env.verify scripts/verify-browser-gridlines.mjs
// 任意: SHOT_OUT（画像の出力先。既定 /tmp）
//
// 副作用: 実機へ表示セッションを 1 本張り、テスト画面を呼ぶだけ。**装置名は指定せず
// ホストに採らせる**（共有機なので既存の装置名を奪わない）。オブジェクトは作らない。
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
const PORT = Number(process.env.PORT ?? 3492);
const EXPECTED_LINES = 13; // build-gridtest6.mjs の GRID_LINES と揃える

const log = (s) => process.stdout.write(s + "\n");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
const check = (cond, msg) => { if (cond) { pass++; log(`  PASS ${msg}`); } else { fail++; log(`  FAIL ${msg}`); } };

const work = mkdtempSync(join(tmpdir(), "gridlines-"));
const cfgPath = join(work, "profiles.json");
// **パスワードはファイルに書かない**——`passwordEnv` で環境変数を指す（verify-cursor-align.mjs と同じ）
writeFileSync(
  cfgPath,
  JSON.stringify({
    systems: [{ id: "AS400", name: "AS400", host, ccsid: 930, signon: { user, passwordEnv: "AS400_PASSWORD" } }],
    // **24x80 で張る**——S9R167D は `DSPSIZ(24 80 *DS3)`（alternate 未申告）で、
    // 旧実装が `clearUnit()` へ倒していた経路をそのまま通す。deviceName は書かない。
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

try {
  await page.goto(`http://localhost:${PORT}/`);
  await page.waitForSelector(".launcher", { timeout: 20000 });
  if (process.env.VERIFY_DEBUG === "1") log("launcher:\n" + (await page.locator(".launcher").innerText()));
  // **システムが 1 つならランチャーは最初からそのセッション一覧を出す**（「選択」は現れない）。
  // 出ているかで分岐する——常に押しに行くと、押す物が無くてタイムアウトする。
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

  // サインオン・回復画面を抜けてコマンド行へ
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

  for (const [pgm, label] of [
    ["GRIDCL8", "罫線 → OVERLAY 無し（素の CLEAR UNIT が挟まる）"],
    ["GRIDCL9", "罫線 → OVERLAY 付き（対照）"]
  ]) {
    log(`\n### ${pgm}: ${label}`);
    await page.keyboard.type(`CALL ${LIB}/${pgm}`);
    await page.keyboard.press("Enter");
    await sleep(3000);

    const shot = join(OUT, `gridlines-${pgm}.png`);
    await page.locator(".pane").screenshot({ path: shot });
    const drawn = await page.locator(".grid-line").count();
    const body = await page.locator(".pane").innerText();
    log(`  撮影: ${shot} / .grid-line = ${drawn} 本`);
    check(body.includes("13 LINES MUST SHOW"), `${pgm}: テスト画面が出ている`);
    check(drawn === EXPECTED_LINES, `${pgm}: 罫線が ${EXPECTED_LINES} 本描かれている（実際 ${drawn} 本）`);

    // 画面を閉じてコマンド行へ戻す
    for (let i = 0; i < 4; i++) {
      if ((await page.locator(".pane").innerText()).includes("コマンドを入力")) break;
      await page.keyboard.press("Enter");
      await sleep(2200);
    }
  }
} catch (err) {
  check(false, err instanceof Error ? err.message : String(err));
} finally {
  await browser.close();
  await new Promise((r) => server.close(r));
  rmSync(work, { recursive: true, force: true });
}

log(`\n${fail === 0 ? "すべて PASS" : `FAIL ${fail} 件`}（PASS ${pass}）`);
process.exit(fail === 0 ? 0 : 1);
