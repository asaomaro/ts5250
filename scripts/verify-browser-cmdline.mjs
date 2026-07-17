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
import { readFileSync } from "node:fs";

const log = (s) => process.stderr.write(s + "\n");
const PORT = 3468;

const sessions = new SessionManager();
// デバイス名は実行ごとにユニークにする。PUB400 は同名デバイスの二重接続を拒否するため、
// 直前の実行のセッションが残っていると次の実行が negotiation で切られる（連続実行で詰まる）。
const raw = JSON.parse(readFileSync("profiles.local.json", "utf8"));
const uniq = Date.now().toString(36).slice(-4).toUpperCase();
for (const p of raw.profiles) if (p.deviceName) p.deviceName = `WEBV${uniq}`.slice(0, 10);
const profiles = new ProfileStore(raw.profiles);
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
  // サインオン後にメニュー以外へ着地することがある（未読メッセージ＝Display Messages、
  // 他セッションがメッセージ待ち行列を持つ＝Display Program Messages）。Enter/F3 で抜けてメニューへ。
  for (let i = 0; i < 6; i++) {
    const scr = await page.evaluate(() => document.querySelector(".grid")?.textContent ?? "");
    if (scr.includes("Main Menu")) break;
    if (!/Display (Program )?Messages/.test(scr)) break;
    await page.locator(".grid").click({ position: { x: 5, y: 5 } }); // キー入力を受けるためペインへフォーカス
    await page.keyboard.press(scr.includes("Display Program Messages") ? "Enter" : "F3");
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

  // ⑥ 行またぎ: 74 桁を超えて入力でき、2 行目へ流れる。1 行目へ混入しない。
  await page.keyboard.press("Home");
  for (let i = 0; i < 12; i++) await page.keyboard.press("Delete");
  await cmd.click();
  await page.keyboard.press("Home");
  await page.keyboard.type("Z".repeat(80), { delay: 5 }); // 74 桁を超える
  await page.waitForTimeout(300);
  const wrap = await page.evaluate(() => {
    const s0 = document.querySelector('input[data-field-index="1"][data-slice="0"]');
    const s1 = document.querySelector('input[data-field-index="1"][data-slice="1"]');
    return {
      slices: document.querySelectorAll('input[data-field-index="1"]').length,
      s0len: s0?.value.length ?? -1,
      s0z: (s0?.value.match(/Z/g) ?? []).length,
      s1z: (s1?.value.match(/Z/g) ?? []).length,
      active: document.activeElement?.dataset?.slice
    };
  });
  rule("⑥ 行またぎ: 80 文字が 74+6 に分かれて 2 行目へ流れる", wrap.s0z === 74 && wrap.s1z === 6, JSON.stringify(wrap));

  // ⑦ アウトフォーカスしても 1 行目に 2 行目の文字が出ない（前回の不具合）
  await page.evaluate(() => document.activeElement.blur());
  await page.waitForTimeout(200);
  const blurred = await page.evaluate(() => {
    const s0 = document.querySelector('input[data-field-index="1"][data-slice="0"]');
    const s1 = document.querySelector('input[data-field-index="1"][data-slice="1"]');
    return { s0z: (s0?.value.match(/Z/g) ?? []).length, s1z: (s1?.value.match(/Z/g) ?? []).length };
  });
  rule("⑦ blur 後も 1 行目に 2 行目の文字が出ない", blurred.s0z === 74 && blurred.s1z === 6, JSON.stringify(blurred));

  // ⑧ 2 行目にフォーカスしても文字が消えない（前回の不具合）
  const s1loc = page.locator('input[data-field-index="1"][data-slice="1"]');
  await s1loc.click();
  await page.waitForTimeout(200);
  const focus2 = await page.evaluate(() => {
    const s1 = document.querySelector('input[data-field-index="1"][data-slice="1"]');
    return { s1z: (s1?.value.match(/Z/g) ?? []).length };
  });
  rule("⑧ 2 行目にフォーカスしても文字が消えない", focus2.s1z === 6, JSON.stringify(focus2));

  // ⑨ 2 行目（折返し先）も欄長までスペース埋めされ、クリックした桁でカーソルが保持される
  await page.keyboard.press("Home");
  for (let i = 0; i < 90; i++) await page.keyboard.press("Delete");
  await page.evaluate(() => document.activeElement.blur());
  await page.waitForTimeout(200);
  const s1meta = await page.evaluate(() => {
    const s1 = document.querySelector('input[data-field-index="1"][data-slice="1"]');
    return { len: s1?.value.length ?? -1 };
  });
  rule("⑨ 2 行目も空欄で 79 桁ぶんスペース埋めされる", s1meta.len === 79, `s1 value長=${s1meta.len}`);

  const s1box = await page.locator('input[data-field-index="1"][data-slice="1"]').boundingBox();
  const s1chW = s1box.width / 79;
  await page.mouse.click(s1box.x + s1chW * 25 + s1chW / 2, s1box.y + s1box.height / 2); // 2 行目の 25 桁目
  await page.waitForTimeout(250);
  const s1click = await page.evaluate(() => ({
    slice: document.activeElement?.dataset?.slice,
    caret: document.activeElement?.selectionStart ?? -1
  }));
  rule(
    "⑨-2 2 行目のクリックした桁でカーソルが保持される（先頭へ飛ばない）",
    s1click.slice === "1" && s1click.caret >= 24 && s1click.caret <= 26,
    JSON.stringify(s1click)
  );

  // ⑩ 全角も上書きが既定（挿入されない）。ABCDEF の 2 桁目に 日 → A日DEF（日 が 2 桁＋SO/SI を食う）
  await page.keyboard.press("Home");
  for (let i = 0; i < 90; i++) await page.keyboard.press("Delete");
  await cmd.click();
  await page.keyboard.press("Home");
  await page.keyboard.type("ABCDEF", { delay: 20 });
  await page.evaluate(() => document.activeElement.setSelectionRange(1, 1));
  await page.evaluate(async () => {
    const el = document.activeElement;
    const dt = new DataTransfer();
    dt.setData("text", "日");
    el.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
  });
  await page.waitForTimeout(250);
  const owDbcs = (await val()).replace(/\s+$/, "");
  // 日 は SO+2+SI=4 桁を占めるので、上書きなら後続 BCDE(4 桁) を食って "A 日 F"（列ビュー）。
  // 挿入だと BCDEF が押し出されて残る（"A 日 BCDEF"）。
  rule("⑩ 全角も上書きが既定（後続 4 桁を食う）", owDbcs === "A 日 F", `"${owDbcs}"`);

  // ⑪ 全角が入った状態で、未入力列を上下移動しても列がずれない
  await page.keyboard.press("Home");
  for (let i = 0; i < 90; i++) await page.keyboard.press("Delete");
  await cmd.click();
  await page.keyboard.press("Home");
  await page.evaluate(async () => {
    const el = document.activeElement;
    const dt = new DataTransfer();
    dt.setData("text", "日本語漢字"); // 全角 5 文字
    el.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
  });
  await page.waitForTimeout(250);
  // 未入力列（40 桁目）へクリック → ↓ で 2 行目 → ↑ で 1 行目へ戻る。列が保たれること
  const b3 = await cmd.boundingBox();
  const w3 = b3.width / 74;
  await page.mouse.click(b3.x + w3 * 40 + w3 / 2, b3.y + b3.height / 2);
  await page.waitForTimeout(200);
  const c1 = await page.evaluate(() => document.activeElement.selectionStart);
  await page.keyboard.press("ArrowDown");
  await page.waitForTimeout(200);
  const c2 = await page.evaluate(() => ({ slice: document.activeElement?.dataset?.slice, caret: document.activeElement?.selectionStart }));
  await page.keyboard.press("ArrowUp");
  await page.waitForTimeout(200);
  const c3 = await page.evaluate(() => ({ slice: document.activeElement?.dataset?.slice, caret: document.activeElement?.selectionStart }));
  rule(
    "⑪ 全角 5 文字がある状態で上下移動しても列がずれない",
    c2.slice === "1" && c3.slice === "0" && c3.caret === c1,
    `1行目caret=${c1} → ↓${JSON.stringify(c2)} → ↑${JSON.stringify(c3)}`
  );

  // ⑫ 未入力状態で 2 行目に DBCS を入力すると、2 行目に入る（1 行目の先頭に入らない）
  await cmd.click();
  await page.keyboard.press("Home");
  for (let i = 0; i < 90; i++) await page.keyboard.press("Delete");
  await page.evaluate(() => document.activeElement.blur());
  await page.waitForTimeout(200);
  const b4 = await page.locator('input[data-field-index="1"][data-slice="1"]').boundingBox();
  const w4 = b4.width / 79;
  await page.mouse.click(b4.x + w4 * 10 + w4 / 2, b4.y + b4.height / 2); // 2 行目の 10 桁目
  await page.waitForTimeout(200);
  const cdp2 = await page.context().newCDPSession(page);
  await cdp2.send("Input.imeSetComposition", { text: "日本", selectionStart: 2, selectionEnd: 2 });
  await cdp2.send("Input.insertText", { text: "日本" });
  await page.waitForTimeout(400);
  const imeRow2 = await page.evaluate(() => {
    const s0 = document.querySelector('input[data-field-index="1"][data-slice="0"]');
    const s1 = document.querySelector('input[data-field-index="1"][data-slice="1"]');
    return { s0: s0?.value ?? "", s1: s1?.value ?? "" };
  });
  rule(
    "⑫ 未入力状態で 2 行目に DBCS 入力 → 2 行目に入る（1 行目の先頭に入らない）",
    !/日|本/.test(imeRow2.s0) && /日本/.test(imeRow2.s1),
    `s0="${imeRow2.s0.trim()}" s1="${imeRow2.s1.replace(/ +$/, "")}"`
  );

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
