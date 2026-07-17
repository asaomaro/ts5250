// 実ブラウザでの複数行ペースト E2E。
//
//   1) 独立した入力欄が縦に並ぶ画面（STRSQL の SQL 入力エリア = row5..18 col7 len68）へ
//      矩形の形のまま落ちる
//   2) 書いた範囲だけ上書きし、後ろの既存文字を残す（"123456" へ "789" → "789456"。
//      旧: 後ろを捨てて "789" になっていた）
//   3) 行またぎ欄（コマンド行）でも折返し先の同じ桁へ落ちる（旧: 2 行目が捨てられていた）
//   4) 挿入モード: 後続を右へずらす／入り切らなければ "No room to insert data." を出して
//      **何も書かない**（ACS: 問題ないと確定するまで書き換えない）
//   5) 帯の折返し: 開始桁〜行末の幅で各行を折り返し、あふれた分は次の帯行の**同じ桁**へ
//
// STRSQL では Enter を押さない（＝SQL を実行しない）。F3 で抜けるだけなのでホストは変更しない。
//
// 前提: npm run build 済み（web-ui も）。profiles.local.json にプロファイル。
// 実行: node --env-file=.env scripts/verify-browser-paste.mjs
import { serve } from "@hono/node-server";
import { WebSocketServer } from "ws";
import { buildApp, SessionManager, ProfileStore } from "@as400web/server";
import { chromium } from "playwright";
import { readFileSync } from "node:fs";

const log = (s) => process.stderr.write(s + "\n");
const PORT = 3473;

const sessions = new SessionManager();
const rawCfg = JSON.parse(readFileSync("profiles.local.json", "utf8"));
const uniqDev = Date.now().toString(36).slice(-4).toUpperCase();
for (const p of rawCfg.profiles) if (p.deviceName) p.deviceName = `WEBV${uniqDev}`.slice(0, 10);
const profiles = new ProfileStore(rawCfg.profiles);
const app = buildApp({ sessions, profiles, version: "test", webRoot: "packages/web-ui/dist" });
const wss = new WebSocketServer({ noServer: true });
const server = serve({ fetch: app.fetch, port: PORT, websocket: { server: wss } });
await new Promise((r) => setTimeout(r, 500));

const prof = (await (await fetch(`http://localhost:${PORT}/api/profiles`)).json()).profiles[0];
if (!prof) { log("NG — プロファイルが必要"); server.close?.(); process.exit(1); }

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1100, height: 700 } });
let ok = true;
const check = (name, cond, d = "") => { log(`${cond ? "PASS" : "FAIL"}  ${name}${d ? "  — " + d : ""}`); ok = ok && cond; };

/** フォーカス中の要素へ text をペースト（クリップボード権限なしで paste 経路を叩く） */
const paste = (text) => page.evaluate((t) => {
  const el = document.activeElement;
  const dt = new DataTransfer();
  dt.setData("text", t);
  el.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
}, text);

/** 画面上の入力欄の値（末尾空白を落として）を上から順に */
const values = () => page.evaluate(() =>
  [...document.querySelectorAll("input.grid-input")].map((i) => i.value.replace(/\s+$/, "")));

try {
  await page.goto(`http://localhost:${PORT}/`);
  await page.locator("button.card", { hasText: prof.name }).first().click();
  await page.waitForFunction(() => (document.querySelector(".grid")?.textContent?.length ?? 0) > 100, { timeout: 20000 });
  for (let i = 0; i < 6; i++) {
    const scr = await page.evaluate(() => document.querySelector(".grid")?.textContent ?? "");
    if (scr.includes("Main Menu")) break;
    if (!/Display (Program )?Messages/.test(scr)) break;
    await page.locator(".grid").click({ position: { x: 5, y: 5 } });
    await page.keyboard.press(scr.includes("Display Program Messages") ? "Enter" : "F3");
    await page.waitForTimeout(2000);
  }
  await page.waitForFunction(() => document.querySelector(".grid")?.textContent?.includes("Main Menu"), { timeout: 20000 });

  // ---- ③ 行またぎ欄（コマンド行）へ複数行ペースト（コマンド行が空の Main Menu で先に試す） ----
  const cmd = page.locator("input.grid-input").first();
  await cmd.click({ position: { x: 2, y: 5 } });
  await page.keyboard.press("Home");
  await paste("AAA\nBBB");
  await page.waitForTimeout(200);
  const wrapped = await values();
  // コマンド行は 2 スライス（row20/row21）に割れる。1 行目=slice0 の先頭、2 行目=slice1 の同じ画面桁
  check("③ 行またぎ欄: 1 行目が 1 スライス目の先頭へ", (wrapped[0] ?? "").startsWith("AAA"), `slice0="${(wrapped[0] ?? "").slice(0, 10)}"`);
  check("③ 行またぎ欄: 2 行目が折返し先の同じ画面桁へ", (wrapped[1] ?? "").slice(6, 9) === "BBB",
    `slice1[6..9]="${(wrapped[1] ?? "").slice(6, 9)}"`);

  // コマンド行を消してから次へ（Delete は左詰め。BBB は欄先頭から 80 桁目にある）
  await cmd.click({ position: { x: 2, y: 5 } });
  await page.keyboard.press("Home");
  for (let i = 0; i < 100; i++) await page.keyboard.press("Delete");
  await page.waitForTimeout(200);
  const cleared = (await values())[0] ?? "";
  check("③ 後始末: コマンド行が空になった", cleared === "", `"${cleared}"`);

  // ---- STRSQL へ（Enter は SQL 実行なので、以降 Enter を押さない） ----
  await cmd.click({ position: { x: 2, y: 5 } });
  await page.keyboard.press("Home");
  await page.keyboard.type("STRSQL");
  await page.keyboard.press("Enter");
  await page.waitForFunction(() => document.querySelector(".grid")?.textContent?.includes("Enter SQL Statements"), { timeout: 20000 });
  log("STRSQL 表示");

  const first = page.locator("input.grid-input").first();
  // ---- ① 独立した入力欄へ矩形のまま落ちる ----
  await first.click({ position: { x: 2, y: 5 } });
  await page.keyboard.press("Home");
  await paste("123456\n123456");
  await page.waitForTimeout(200);
  let v = await values();
  check("① 独立した欄へ 1 行ずつ落ちる", v[0] === "123456" && v[1] === "123456", `[0]="${v[0]}" [1]="${v[1]}"`);

  // ---- ② 書いた範囲だけ上書きし、後ろを残す ----
  await first.click({ position: { x: 2, y: 5 } });
  await page.keyboard.press("Home");
  await paste("789\n789");
  await page.waitForTimeout(200);
  v = await values();
  check("② 後ろの既存文字が残る（789456 になる）", v[0] === "789456" && v[1] === "789456", `[0]="${v[0]}" [1]="${v[1]}"`);
  // ---- ④ 挿入モード（Insert キーで切替） ----
  await first.click({ position: { x: 2, y: 5 } });
  await page.keyboard.press("Home");
  await page.keyboard.press("Insert");
  await page.waitForTimeout(100);
  const mode = await page.evaluate(() => document.querySelector(".oia .mode")?.textContent?.trim());
  check("④ Insert キーで挿入モードになる", mode === "挿入", `"${mode}"`);

  // 現状 [0]="789456" [1]="789456"（10 桁欄）。挿入で 3 桁足すと 9 桁＝入る
  await paste("ABC\nABC");
  await page.waitForTimeout(200);
  v = await values();
  check("④ 挿入は後続を右へずらす", v[0] === "ABC789456" && v[1] === "ABC789456", `[0]="${v[0]}" [1]="${v[1]}"`);

  // 欄は 68 桁。現在 9 桁なので 60 桁挿すと 69 > 68 → エラー。値は変わらない
  const long = "X".repeat(60);
  await first.click({ position: { x: 2, y: 5 } });
  await page.keyboard.press("Home");
  await paste(`${long}\n${long}`);
  await page.waitForTimeout(200);
  const after = await values();
  const msg = await page.evaluate(() => document.querySelector(".oia .notice")?.textContent?.trim() ?? "");
  check("④ 入り切らなければ No room to insert data.", msg === "No room to insert data.", `"${msg}"`);
  check("④ エラー時は何も書き換えない", after[0] === v[0] && after[1] === v[1], `[0]="${after[0]}" [1]="${after[1]}"`);

  // 次のキー操作でメッセージが消える（キーボードはロックしない）
  await page.keyboard.press("Home");
  await page.waitForTimeout(100);
  const gone = await page.evaluate(() => document.querySelector(".oia .notice") === null);
  check("④ 次の操作でメッセージが消える", gone);

  // ---- ⑤ 帯の折返し（上書きモードへ戻す）----
  await first.click({ position: { x: 2, y: 5 } });
  await page.keyboard.press("Insert"); // 上書きへ
  await page.waitForTimeout(100);
  // 欄は 68 桁（col7..74）。67 桁目から貼ると帯幅 2 → "111" は "11" ＋ 次の帯行に "1"
  const at = 67;
  await page.evaluate((n) => document.activeElement.setSelectionRange(n - 1, n - 1), at);
  // 2 行の矩形 = 帯行 4 つ。SQL 入力エリアの行数に依存しない範囲で見る
  await paste("111\n222");
  await page.waitForTimeout(250);
  const band = (await values()).slice(0, 4).map((s) => s.slice(at - 1));
  const wantBand = ["11", "1", "22", "2"];
  check("⑤ 帯幅 2 で折り返し、あふれは次の帯行の同じ桁へ",
    JSON.stringify(band) === JSON.stringify(wantBand), `${JSON.stringify(band)} 期待 ${JSON.stringify(wantBand)}`);

  // SQL は実行しない。セッションはブラウザを閉じれば切れる
} catch (e) {
  ok = false;
  log("ERROR: " + (e?.stack ?? e?.message ?? e));
} finally {
  await browser.close();
  server.close?.();
}
log(ok ? "\nOK — 複数行ペースト" : "\nNG");
process.exit(ok ? 0 : 1);
