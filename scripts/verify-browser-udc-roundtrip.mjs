// **外字（UDC）を含む DBCS 欄を編集して送り返しても壊れない**ことを実機で確かめる。
//
// CCSID 930 の外字（0x6941〜）は Unicode の私用面 U+E000〜へ落ちる。ts5250 は
// 「表示できないバイト・埋め込み属性」を運ぶセンチネルにも私用面 U+E000+byte を使っており、
// **U+E000〜U+E0FF がまるごと衝突していた**——web-ui は DBCS 欄を編集するとき値をセルから
// 組み立て直す（`logicalFromCells`）ので、外字 1 文字がセンチネルと見分けられず
// **生バイト 1 つ（0x00）に化けて SO/SI ごと消える**。
//
// 検証資材は scripts/build-udctest.mjs が作る <LIB>/UDCDSPF ＋ UDCPGM。
// 画面には外字 1 文字が出ている。**その後ろに `AB` を打って Enter**すると、ホストは
// `x'0E69410FC1C2'` を受け取るはず（SAME）。壊れていれば DIFF。
//
// 実行:
//   npm run build && npm run build -w @ts5250/web-ui
//   node --env-file=.env --env-file=.env.verify scripts/verify-browser-udc-roundtrip.mjs
// 任意: SHOT_OUT（画像の出力先。既定 /tmp）
//
// ⚠ 外字の**字形**は出ない（ホストの外字フォントの話）。見ているのはバイトの identity だけ。
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
const PORT = Number(process.env.PORT ?? 3499);

const IN1 = { row: 3, col: 30 };
const EOK_ROW = 5, ECHO_ROW = 7;

const log = (s) => process.stdout.write(s + "\n");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
const check = (cond, msg) => { if (cond) { pass++; log(`  PASS ${msg}`); } else { fail++; log(`  FAIL ${msg}`); } };

const work = mkdtempSync(join(tmpdir(), "udc-"));
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
const sel = `input.grid-input[data-field="f${IN1.row}c${IN1.col}"]`;
/** 画面テキストの 1 行（出力専用の欄はセルとして出る） */
const line = (row) =>
  page.evaluate((r) => ([...document.querySelectorAll(".grid-row")][r - 1]?.textContent ?? ""), row);

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

  await page.keyboard.type(`CALL ${LIB}/UDCPGM`);
  await page.keyboard.press("Enter");
  await sleep(3000);
  check((await page.locator(".pane").innerText()).includes("UDC ROUND TRIP TEST"), "UDCPGM のテスト画面が出ている");

  // 欄に出ている外字を見る（**入力欄の値**。`.grid-row` の textContent には <input> の値が入らない）。
  // 私用面 U+E000〜へ落ちているはず——旧実装はここをセンチネルと見なして空白へ潰していた。
  const shown = await page.locator(sel).inputValue();
  const pua = [...shown].map((c) => c.codePointAt(0) ?? 0).filter((c) => c >= 0xe000 && c <= 0xf8ff);
  log(`\n### 画面に出た外字`);
  log(`  欄の値: ${JSON.stringify(shown)} / 私用面の符号位置: ${pua.map((c) => "U+" + c.toString(16).toUpperCase()).join(" ") || "(無し)"}`);
  check(pua.length > 0, "外字が私用面の文字として欄に出ている（空白へ潰されない）");

  // --- 欄の末尾に AB を打って送る（web-ui の DBCS 編集経路をそのまま通す） ---
  log(`\n### 外字のある欄を編集して送る`);
  const el = page.locator(sel);
  await el.click();
  await page.keyboard.press("End");
  await sleep(150);
  await page.keyboard.type("AB", { delay: 60 });
  await sleep(250);
  await page.keyboard.press("Enter");
  await sleep(2500);

  const eok = (await line(EOK_ROW)).slice(29, 33).trim();
  const echo = [...(await line(ECHO_ROW)).slice(29, 39)]
    .map((c) => (c.codePointAt(0) ?? 0) >= 0x20 ? c : ".")
    .join("")
    .trimEnd();
  const shot = join(OUT, "udc-roundtrip.png");
  await page.locator(".pane").screenshot({ path: shot });
  log(`  RESULT=${JSON.stringify(eok)} / ECHO=${JSON.stringify(echo)}`);
  log(`  画像: ${shot}`);
  check(eok !== "NONE", `欄がホストへ送り返されている（実際 ${JSON.stringify(eok)}）`);
  check(eok === "SAME", `外字が壊れずに届く（実際 ${JSON.stringify(eok)}）`);

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
