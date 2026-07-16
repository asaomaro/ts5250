// 実ブラウザでのコマンド行 E2E（DBCS 欄）。build 済み web-ui を server で配信し、Playwright で
// CCSID 1399 プロファイルへ接続 → メインメニューのコマンド行（dbcsType:"open" の行またぎ欄）で
// カーソル移動・入力順・ペーストを検証する。実アプリ構成（EmulatorPane 込み）を通すのが要点。
//   ※ ScreenGrid 単体のハーネスでは EmulatorPane のフォーカス調停を通らず不具合を見逃す。
// 前提: npm run build && npm run build -w @as400web/web-ui 済み。profiles.local.json に CCSID 1399 のプロファイル。
// 実行: node --env-file=.env scripts/verify-browser-cmdline.mjs
import { serve } from "@hono/node-server";
import { WebSocketServer } from "ws";
import { buildApp, SessionManager, ProfileStore } from "@as400web/server";
import { chromium } from "playwright";

const log = (s) => process.stderr.write(s + "\n");
const PORT = 3468;

const sessions = new SessionManager();
const profiles = ProfileStore.fromFile("profiles.local.json");
const app = buildApp({ sessions, profiles, version: "test", webRoot: "packages/web-ui/dist" });
const wss = new WebSocketServer({ noServer: true });
const server = serve({ fetch: app.fetch, port: PORT, websocket: { server: wss } });
await new Promise((r) => setTimeout(r, 500));

const list = await (await fetch(`http://localhost:${PORT}/api/profiles`)).json();
const jp = list.profiles.find((p) => p.ccsid === 1399);
if (!jp) {
  log("NG — CCSID 1399 のプロファイルがありません");
  server.close?.();
  process.exit(1);
}

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1300, height: 800 } });
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
let ok = true;
const rule = (name, cond, d = "") => {
  log(`${cond ? "PASS" : "FAIL"}  ${name}${d ? "  — " + d : ""}`);
  ok = ok && cond;
};

try {
  await page.goto(`http://localhost:${PORT}/`);
  await page.locator("button.card", { hasText: jp.name }).first().click();
  await page.waitForFunction(() => (document.querySelector(".grid")?.textContent?.length ?? 0) > 100, { timeout: 20000 });
  // 未読メッセージがあるとサインオン後に Display Messages へ着地する。F3 で抜けてメニューへ。
  for (let i = 0; i < 4; i++) {
    const onMsg = await page.evaluate(
      () => document.querySelector(".grid")?.textContent?.includes("Display Messages") ?? false
    );
    if (!onMsg) break;
    await page.locator(".grid").click({ position: { x: 5, y: 5 } }); // キー入力を受けるためペインへフォーカス
    await page.keyboard.press(i % 2 === 0 ? "F3" : "Enter");
    await page.waitForTimeout(2000);
  }
  try {
    await page.waitForFunction(() => document.querySelector(".grid")?.textContent?.includes("Main Menu"), { timeout: 20000 });
  } catch {
    const dump = await page.evaluate(() => ({
      err: document.querySelector(".err")?.textContent ?? "",
      grid: (document.querySelector(".grid")?.innerText ?? "(no grid)").slice(0, 300),
      cards: [...document.querySelectorAll("button.card")].map((b) => b.textContent.trim().slice(0,40))
    }));
    log("DUMP err=" + dump.err);
    log("DUMP cards=" + JSON.stringify(dump.cards));
    log("DUMP grid=" + dump.grid.replace(/\n/g, " / "));
    throw new Error("Main Menu に到達せず");
  }
  log(`接続 OK（${jp.name} / ccsid ${jp.ccsid}）`);

  const cmd = page.locator("input.grid-input:not([readonly])").first();
  const val = async () => await cmd.inputValue();

  // コマンド行が DBCS 欄（1399 接続では dbcsType:"open"）であることを確認
  const meta = await page.evaluate(() => {
    const el = document.querySelector("input.grid-input:not([readonly])");
    return { len: el.value.length, maxlength: el.getAttribute("maxlength"), slice: el.dataset.slice };
  });
  log(`コマンド行: value長=${meta.len} maxlength=${meta.maxlength} slice=${meta.slice}`);

  // ① 未入力エリアへのカーソル移動（空欄でも欄内の任意桁に置けるか）
  await cmd.click();
  await page.waitForTimeout(150);
  const caretMove = await page.evaluate(async () => {
    const el = document.activeElement;
    const before = el.value.length;
    el.setSelectionRange(10, 10);
    return { valueLen: before, caret: el.selectionStart };
  });
  rule(
    "① 空のコマンド行で 10 桁目へカーソルを置ける（未入力エリアのスペース埋め）",
    caretMove.caret === 10,
    `value長=${caretMove.valueLen} caret=${caretMove.caret}`
  );

  // ①-2 実クリックしたその桁でカーソルが保持される（先頭へ飛ばない）。SBCS/数値欄と同じ挙動。
  await page.evaluate(() => document.activeElement.blur());
  await page.waitForTimeout(100);
  const box = await cmd.boundingBox();
  const chW = box.width / 74; // コマンド行 1 行目は 74 桁
  await page.mouse.click(box.x + chW * 20 + chW / 2, box.y + box.height / 2); // 20 桁目あたり
  await page.waitForTimeout(200);
  const clicked = await page.evaluate(() => document.activeElement.selectionStart);
  rule("①-2 クリックした桁でカーソルが保持される（先頭へ飛ばない）", clicked >= 19 && clicked <= 21, `caret=${clicked}`);

  // ①-3 矢印で欄外から入ってきたとき、到達した桁が保持される（先頭へ飛ばない）
  //     コマンド行の 1 つ上の行（非入力）から ↓ で欄内へ入る。列位置は保たれる仕様。
  const box2 = await cmd.boundingBox();
  const chW2 = box2.width / 74;
  await page.mouse.click(box2.x + chW2 * 30 + chW2 / 2, box2.y + box2.height / 2); // 30 桁目
  await page.waitForTimeout(200);
  await page.keyboard.press("ArrowUp"); // 上の非入力行へ出る（欄外＝free モード）
  await page.waitForTimeout(200);
  await page.keyboard.press("ArrowDown"); // 真下＝コマンド行へ戻る（列位置は保たれる仕様）
  await page.waitForTimeout(250);
  const arrived = await page.evaluate(() => ({
    tag: document.activeElement?.tagName,
    caret: document.activeElement?.selectionStart ?? -1
  }));
  rule(
    "①-3 矢印で入った桁が保持される（先頭へ飛ばない）",
    arrived.tag === "INPUT" && arrived.caret > 10,
    `tag=${arrived.tag} caret=${arrived.caret}`
  );

  // ② 入力順（abcdefg と打ったら abcdefg になるか）
  await cmd.click();
  await page.keyboard.press("Home");
  await page.keyboard.type("abcdefg", { delay: 30 });
  await page.waitForTimeout(200);
  const typed = (await val()).replace(/\s+$/, "");
  rule("② abcdefg と入力したら abcdefg になる（順序が入れ替わらない）", typed === "abcdefg", `"${typed}"`);

  // 消してから次へ
  await page.keyboard.press("Home");
  for (let i = 0; i < 10; i++) await page.keyboard.press("Delete");
  await page.waitForTimeout(150);

  // ③ DBCS ペースト
  await cmd.click();
  await page.keyboard.press("Home");
  await page.evaluate(async () => {
    const el = document.activeElement;
    const dt = new DataTransfer();
    dt.setData("text", "日本語");
    el.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
  });
  await page.waitForTimeout(200);
  const pasted = (await val()).replace(/\s+$/, "");
  rule("③ DBCS をコマンド行にペーストできる", /日本語/.test(pasted), `"${pasted}"`);

  // 消してから次へ
  await page.keyboard.press("Home");
  for (let i = 0; i < 12; i++) await page.keyboard.press("Delete");
  await page.waitForTimeout(150);

  // ④ 上書きが既定（5250）。ABCDE の途中 2 桁目に X → AXCDE
  await cmd.click();
  await page.keyboard.press("Home");
  await page.keyboard.type("ABCDE", { delay: 30 });
  await page.evaluate(() => document.activeElement.setSelectionRange(1, 1));
  await page.keyboard.type("X", { delay: 30 });
  await page.waitForTimeout(200);
  const ow = (await val()).replace(/\s+$/, "");
  rule("④ 上書きが既定（AXCDE。挿入なら AXBCDE になる）", ow === "AXCDE", `"${ow}"`);

  // ⑤ Insert トグルで挿入になる
  await page.evaluate(() => document.activeElement.setSelectionRange(1, 1));
  await page.keyboard.press("Insert");
  await page.keyboard.type("Y", { delay: 30 });
  await page.waitForTimeout(200);
  const ins = (await val()).replace(/\s+$/, "");
  rule("⑤ Insert トグルで挿入になる（AYXCDE）", ins === "AYXCDE", `"${ins}"`);
  await page.keyboard.press("Insert"); // 戻す

  if (errors.length) {
    ok = false;
    log("PAGE ERRORS: " + errors.join(" | "));
  }
} catch (e) {
  ok = false;
  log("BROWSER E2E ERROR: " + e.message);
} finally {
  await browser.close();
  server.close?.();
}
log(ok ? "\nOK — コマンド行（DBCS 欄）" : "\nNG");
process.exit(ok ? 0 : 1);
