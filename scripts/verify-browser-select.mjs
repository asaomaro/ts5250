// 実ブラウザでの矩形（ブロック）選択 E2E。ACS に合わせた「カーソルは選択の始点に置き、
// 範囲を広げても動かさない」を検証する。
//
//   1) マウスドラッグ: 押下したセルにカーソルが移る（旧: カーソルは動かず放置されていた）
//   2) マウスドラッグ: 広げてもカーソルは始点から動かない
//   3) マウス選択も修飾なしカーソル移動で解除される（旧: キーボード選択のアンカー依存で残っていた）
//   4) ダブルクリック: カーソル下の語を矩形選択（未送信の入力値も含む・入力欄は blur）
//   5) キーボード Shift+矢印: カーソルは動かない（旧: 選択端へ移動していた）
//   6) キーボード: 選択端は 2 回ぶん伸びる（基点にカーソルを使うと 1 桁で頭打ちになる回帰）
//   7) 重なり順: カーソルが矩形ハイライトより上に描かれる（始点は必ず矩形の角なので、
//      下に置くとハイライトに沈む）。jsdom は scoped CSS を解決しないためここで担保する。
//
// 前提: npm run build 済み（web-ui も）。profiles.local.json にプロファイル。
// 実行: node --env-file=.env scripts/verify-browser-select.mjs
import { serve } from "@hono/node-server";
import { WebSocketServer } from "ws";
import { buildApp, SessionManager, ProfileStore } from "@as400web/server";
import { chromium } from "playwright";
import { readFileSync } from "node:fs";

const log = (s) => process.stderr.write(s + "\n");
const PORT = 3471;

const sessions = new SessionManager();
// PUB400 は同名デバイスの二重接続を拒否するため、実行ごとにユニークなデバイス名にする
const rawCfg = JSON.parse(readFileSync("profiles.local.json", "utf8"));
const uniqDev = Date.now().toString(36).slice(-4).toUpperCase();
for (const p of rawCfg.profiles) if (p.deviceName) p.deviceName = `WEBQ${uniqDev}`.slice(0, 10);
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

/** カーソル・選択矩形の位置を実測（px）。無ければ null */
const boxes = () => page.evaluate(() => {
  const r = (sel) => { const e = document.querySelector(sel); if (!e) return null; const b = e.getBoundingClientRect(); return { x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.width), h: Math.round(b.height) }; };
  return { cursor: r(".cursor"), rect: r(".rect-sel") };
});

try {
  await page.goto(`http://localhost:${PORT}/`);
  await page.locator("button.card", { hasText: prof.name }).first().click();
  await page.waitForFunction(() => (document.querySelector(".grid")?.textContent?.length ?? 0) > 100, { timeout: 20000 });
  // サインオン後にメッセージ画面へ着地することがある
  for (let i = 0; i < 6; i++) {
    const scr = await page.evaluate(() => document.querySelector(".grid")?.textContent ?? "");
    if (scr.includes("Main Menu")) break;
    if (!/Display (Program )?Messages/.test(scr)) break;
    await page.locator(".grid").click({ position: { x: 5, y: 5 } });
    await page.keyboard.press(scr.includes("Display Program Messages") ? "Enter" : "F3");
    await page.waitForTimeout(2000);
  }
  await page.waitForFunction(() => document.querySelector(".grid")?.textContent?.includes("Main Menu"), { timeout: 20000 });
  log("Main Menu 表示");

  // グリッドの実測字幅・行高からセル座標を出す
  const geo = await page.evaluate(() => {
    const g = document.querySelector(".grid");
    const b = g.getBoundingClientRect();
    const ruler = document.querySelector(".cell-ruler");
    const charW = ruler.getBoundingClientRect().width / 10;
    const lineH = parseFloat(getComputedStyle(g).fontSize) * 1.25;
    return { gx: b.x, gy: b.y, charW, lineH };
  });
  const xOf = (c) => geo.gx + 10 + (c - 1) * geo.charW + geo.charW / 2;
  const yOf = (r) => geo.gy + 8 + (r - 1) * geo.lineH + geo.lineH / 2;
  const cellLeft = (c) => Math.round(geo.gx + 10 + (c - 1) * geo.charW);

  // ---- マウスドラッグ: (4,60) から (6,70) へ（保護テキスト／空白域） ----
  await page.mouse.move(xOf(60), yOf(4));
  await page.mouse.down();
  await page.mouse.move(xOf(65), yOf(5));
  await page.waitForTimeout(60);
  const mid = await boxes();
  check("① ドラッグ開始セルにカーソルが移る", mid.cursor !== null && Math.abs(mid.cursor.x - cellLeft(60)) <= 2,
    `cursor.x=${mid.cursor?.x} 期待≒${cellLeft(60)}`);
  await page.mouse.move(xOf(70), yOf(6));
  await page.waitForTimeout(60);
  const end = await boxes();
  check("② 広げてもカーソルは始点から動かない", end.cursor !== null && mid.cursor !== null && end.cursor.x === mid.cursor.x && end.cursor.y === mid.cursor.y,
    `${JSON.stringify(mid.cursor)} → ${JSON.stringify(end.cursor)}`);
  check("③ 矩形が広がっている", end.rect !== null && end.rect.w > (mid.rect?.w ?? 0), `幅 ${mid.rect?.w} → ${end.rect?.w}`);

  // ---- 重なり順: カーソルが矩形ハイライトより上に描かれる ----
  const stack = await page.evaluate(() => {
    const z = (sel) => getComputedStyle(document.querySelector(sel)).zIndex;
    return { cursor: z(".cursor"), rect: z(".rect-sel") };
  });
  check("④ カーソルが矩形ハイライトより上に描かれる", Number(stack.cursor) > Number(stack.rect),
    `cursor z=${stack.cursor} / rect z=${stack.rect}`);
  await page.mouse.up();

  // ---- マウスで作った選択も修飾なしカーソル移動で解除される ----
  // （旧: 解除条件がキーボード選択のアンカーに依存し、マウス選択だけ残っていた）
  await page.keyboard.press("ArrowRight");
  await page.waitForTimeout(60);
  const afterArrow = await boxes();
  check("⑤ マウス選択も修飾なし矢印で解除される", afterArrow.rect === null, `rect=${JSON.stringify(afterArrow.rect)}`);

  // ---- ダブルクリックで語を矩形選択（入力欄の上。実ブラウザは native の語選択を作るので、
  //      それを畳んで blur できているかがここでしか見られない） ----
  await page.keyboard.press("Escape");
  await page.waitForTimeout(60);
  const cmd = page.locator("input.grid-input").first();
  // 欄の先頭桁をクリックする（既定の中央クリックだと caret が欄の真ん中に落ち、そこへ打ち込まれる）
  await cmd.click({ position: { x: 2, y: 5 } });
  await page.keyboard.type("WRKACTJOB");
  await page.waitForTimeout(60);
  const cmdBox = await cmd.boundingBox();
  // 打った語の途中（4 文字目あたり）をダブルクリック
  await page.mouse.dblclick(cmdBox.x + geo.charW * 3.5, cmdBox.y + cmdBox.height / 2);
  await page.waitForTimeout(80);
  const dbl = await boxes();
  const want = Math.round(geo.charW * 9); // "WRKACTJOB" = 9 桁
  check("⑥ ダブルクリックで未送信の語が矩形選択される", dbl.rect !== null && Math.abs(dbl.rect.w - want) <= 3,
    `幅 ${dbl.rect?.w}px 期待≒${want}px（9 桁）`);
  check("⑦ ダブルクリックで入力欄が blur される（画面の矩形選択へ切替）",
    await page.evaluate(() => document.activeElement?.tagName !== "INPUT"));
  // アプリの copy ハンドラ（document・bubble）が setData した後に読む必要がある。
  // capture で読むとアプリより先に走って空になる
  const copied = await page.evaluate(() => {
    let got = "";
    const h = (e) => { got = e.clipboardData?.getData("text/plain") ?? ""; };
    document.addEventListener("copy", h);
    document.execCommand("copy");
    document.removeEventListener("copy", h);
    return got;
  });
  check("⑧ コピーは語だけ", copied === "WRKACTJOB", `"${copied}"`);
  await page.keyboard.press("Escape");
  await page.waitForTimeout(60);

  // ---- キーボード Shift+矢印 ----
  await page.keyboard.press("Escape");
  await page.waitForTimeout(60);
  await page.mouse.click(xOf(60), yOf(4)); // 空白セルへカーソルを置く（free モード）
  await page.waitForTimeout(60);
  const before = await boxes();
  await page.keyboard.press("Shift+ArrowRight");
  await page.keyboard.press("Shift+ArrowRight");
  await page.keyboard.press("Shift+ArrowDown");
  await page.waitForTimeout(60);
  const after = await boxes();
  check("⑨ Shift+矢印でカーソルは動かない", before.cursor !== null && after.cursor !== null && after.cursor.x === before.cursor.x && after.cursor.y === before.cursor.y,
    `${JSON.stringify(before.cursor)} → ${JSON.stringify(after.cursor)}`);
  // 2 回ぶん伸びる（基点にカーソルを使うと 1 桁で頭打ち）
  const wantW = Math.round(geo.charW * 3);
  check("⑩ 選択端は Shift+→ 2 回ぶん伸びる", after.rect !== null && Math.abs(after.rect.w - wantW) <= 3,
    `幅 ${after.rect?.w}px 期待≒${wantW}px（3 桁）`);
} catch (e) {
  ok = false;
  log("ERROR: " + (e?.stack ?? e?.message ?? e));
} finally {
  await browser.close();
  server.close?.();
}
log(ok ? "\nOK — 矩形選択（カーソルは始点に固定）" : "\nNG");
process.exit(ok ? 0 : 1);
