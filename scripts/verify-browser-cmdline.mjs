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

  // ⑥ 全角も上書きが既定（挿入されない）。ABCDEF の 2 桁目に 日 → 日 は SO+2+SI=4 桁を
  //    占めるので後続 BCDE(4 桁) を食って列ビュー "A 日 F"。挿入だと "A 日 BCDEF" が残る。
  await page.keyboard.press("Home");
  for (let i = 0; i < 20; i++) await page.keyboard.press("Delete");
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
  rule("⑥ 全角も上書きが既定（後続 4 桁を食う）", owDbcs === "A 日 F", `"${owDbcs}"`);

  // ⑦ 実 IME で確定した全角も上書きになる（IME 経路も dbcsType を通ること）
  await page.keyboard.press("Home");
  for (let i = 0; i < 20; i++) await page.keyboard.press("Delete");
  await cmd.click();
  await page.keyboard.press("Home");
  await page.keyboard.type("ABCDEF", { delay: 20 });
  await page.evaluate(() => document.activeElement.setSelectionRange(1, 1));
  const cdpIme = await page.context().newCDPSession(page);
  await cdpIme.send("Input.imeSetComposition", { text: "日", selectionStart: 1, selectionEnd: 1 });
  await cdpIme.send("Input.insertText", { text: "日" });
  await page.waitForTimeout(300);
  const imeOw = (await val()).replace(/\s+$/, "");
  rule("⑦ 実 IME 確定の全角も上書きになる", imeOw === "A 日 F", `"${imeOw}"`);


  // ⑧ 全角が入った状態で、上の行から矢印で入ってきたときに到達桁が保たれる
  //    （表示桁を列ビュー index として渡していると、全角のぶんずれて右端へ飛ぶ）
  await page.keyboard.press("Home");
  for (let i = 0; i < 20; i++) await page.keyboard.press("Delete");
  await cmd.click();
  await page.keyboard.press("Home");
  await page.evaluate(async () => {
    const el = document.activeElement;
    const dt = new DataTransfer();
    dt.setData("text", "ああああああ"); // 全角 6 文字＝14 桁（SO+12+SI）
    el.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
  });
  await page.waitForTimeout(250);
  const b5 = await cmd.boundingBox();
  const w5 = b5.width / 74;
  await page.mouse.click(b5.x + w5 * 30 + w5 / 2, b5.y + b5.height / 2); // 30 桁目（全角より右の未入力桁）
  await page.waitForTimeout(200);
  const before5 = await page.evaluate(() => document.activeElement.selectionStart);
  await page.keyboard.press("ArrowUp"); // 上の非入力行へ
  await page.waitForTimeout(200);
  await page.keyboard.press("ArrowDown"); // 真下＝コマンド行へ戻る
  await page.waitForTimeout(250);
  const after5 = await page.evaluate(() => ({
    tag: document.activeElement?.tagName,
    caret: document.activeElement?.selectionStart ?? -1
  }));
  rule(
    "⑧ 全角がある欄へ矢印で入っても到達桁が保たれる（右端へ飛ばない）",
    after5.tag === "INPUT" && after5.caret === before5,
    `入る前caret=${before5} → ${JSON.stringify(after5)}`
  );

  // ⑨ showShiftMarks（SO/SI を { }）有効でも、矢印での到達桁が保たれる
  await page.getByRole("button", { name: /SO\/SI/ }).click(); // { } 表示へ
  await page.waitForTimeout(300);
  await cmd.click();
  await page.keyboard.press("Home");
  for (let i = 0; i < 20; i++) await page.keyboard.press("Delete");
  await page.evaluate(async () => {
    const el = document.activeElement;
    const dt = new DataTransfer();
    dt.setData("text", "あいうえお");
    el.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
  });
  await page.waitForTimeout(250);
  const marked = await val();
  const b6 = await cmd.boundingBox();
  const w6 = b6.width / 74;
  await page.mouse.click(b6.x + w6 * 22 + w6 / 2, b6.y + b6.height / 2); // 22 桁目（{あいうえお} より右）
  await page.waitForTimeout(200);
  const before6 = await page.evaluate(() => document.activeElement.selectionStart);
  await page.keyboard.press("ArrowUp");
  await page.waitForTimeout(200);
  await page.keyboard.press("ArrowDown");
  await page.waitForTimeout(250);
  const after6 = await page.evaluate(() => ({
    tag: document.activeElement?.tagName,
    caret: document.activeElement?.selectionStart ?? -1,
    len: document.activeElement?.value?.length ?? -1
  }));
  rule(
    "⑨ { } 表示でも矢印での到達桁が保たれる（右端へ飛ばない）",
    after6.tag === "INPUT" && after6.caret === before6,
    `value="${marked.replace(/ +$/, "")}" 入る前caret=${before6} → ${JSON.stringify(after6)}`
  );

  // ⑩ 非入力行（"Selection or command" の行）をクリックしてフリーカーソルを置き、
  //    そこから ↓ でコマンド行へ入る。到達桁が保たれること。
  await page.getByRole("button", { name: /SO\/SI/ }).click(); // { } 表示を戻す
  await page.waitForTimeout(200);
  await cmd.click();
  await page.keyboard.press("Home");
  for (let i = 0; i < 20; i++) await page.keyboard.press("Delete");
  await page.evaluate(async () => {
    const el = document.activeElement;
    const dt = new DataTransfer();
    dt.setData("text", "あいうえお");
    el.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
  });
  await page.waitForTimeout(250);
  // コマンド行の 1 行上（非入力）の 22 桁目付近をクリック → フリーカーソル
  const b7 = await cmd.boundingBox();
  const w7 = b7.width / 74;
  await page.mouse.click(b7.x + w7 * 15 + w7 / 2, b7.y - b7.height * 0.9);
  await page.waitForTimeout(250);
  const freePos = await page.evaluate(() => document.activeElement?.tagName);
  await page.keyboard.press("ArrowDown"); // 真下＝コマンド行へ
  await page.waitForTimeout(300);
  const landed = await page.evaluate(() => ({
    tag: document.activeElement?.tagName,
    caret: document.activeElement?.selectionStart ?? -1,
    len: document.activeElement?.value?.length ?? -1
  }));
  rule(
    "⑩ 非入力行から ↓ で入っても到達桁が保たれる（右端へ飛ばない）",
    landed.tag === "INPUT" && landed.caret > 0 && landed.caret < landed.len - 5,
    `クリック時=${freePos} → ${JSON.stringify(landed)}`
  );

  // ⑪ SBCS と DBCS で、指定桁への着地が一致すること（全角があっても桁感覚が変わらない）
  //    全角は 2 桁を占めるため、桁 → キャレットの丸め方を誤ると SBCS より 1 桁ずれる。
  const caretCol = () =>
    page.evaluate(() => {
      const el = document.activeElement;
      if (el.tagName !== "INPUT") return -1;
      const cs = getComputedStyle(el);
      const cv = document.createElement("canvas").getContext("2d");
      cv.font = `${cs.fontSize} ${cs.fontFamily}`;
      const unit = cv.measureText("0").width;
      return Math.round(cv.measureText(el.value.slice(0, el.selectionStart)).width / unit);
    });
  const fill = async (text, ime) => {
    await cmd.click();
    await page.keyboard.press("Home");
    for (let i = 0; i < 30; i++) await page.keyboard.press("Delete");
    if (ime) {
      const c = await page.context().newCDPSession(page);
      await c.send("Input.imeSetComposition", { text, selectionStart: text.length, selectionEnd: text.length });
      await c.send("Input.insertText", { text });
    } else {
      await page.keyboard.type(text, { delay: 10 });
    }
    await page.waitForTimeout(300);
  };
  const landing = async (colOffset) => {
    const bx = await cmd.boundingBox();
    const cw = bx.width / 74;
    await page.mouse.click(bx.x + cw * colOffset + cw / 2, bx.y - bx.height * 0.9); // 上の非入力行
    await page.waitForTimeout(120);
    await page.keyboard.press("ArrowDown");
    await page.waitForTimeout(180);
    return await caretCol();
  };
  // ああああああ は桁 1..12 を占める（SO=0 / あ=1-2,3-4,… / SI=13）。全角の後半桁（2,4,6,8,10,12）は
  // 全角の途中なのでカーソルを置けず前半へ丸まる（5250 準拠）。それ以外は SBCS と一致すべき。
  const cols = [0, 1, 3, 5, 7, 9, 11, 13, 14, 15, 20];
  await page.getByRole("button", { name: /SO\/SI/ }).click(); // { } 表示（ユーザー報告時の条件）
  await page.waitForTimeout(250);
  await fill("aiueo", false);
  const sbcsCols = [];
  for (const c of cols) sbcsCols.push(await landing(c));
  await fill("ああああああ", true);
  const dbcsCols = [];
  for (const c of cols) dbcsCols.push(await landing(c));
  const mismatch = cols.filter((c, i) => sbcsCols[i] !== dbcsCols[i]);
  rule(
    "⑪ 全角の途中でない桁への着地は SBCS と DBCS で一致する",
    mismatch.length === 0,
    `桁=${cols.join(",")} / SBCS=${sbcsCols.join(",")} / DBCS=${dbcsCols.join(",")}` +
      (mismatch.length ? ` / 差=${mismatch.join(",")}` : "")
  );

  // ⑫ 入力欄に打った値を矩形選択（実マウスドラッグ）→ copy で取得できる
  //    従来は cells（ホストが描いた内容）だけを見ており、未送信の入力値が取れなかった。
  await cmd.click();
  await page.keyboard.press("Home");
  for (let i = 0; i < 30; i++) await page.keyboard.press("Delete");
  await page.keyboard.type("COPYTEST", { delay: 15 });
  await page.waitForTimeout(250);
  const cb = await cmd.boundingBox();
  const cw = cb.width / 74;
  // 欄の 0..8 桁目をドラッグして矩形選択
  await page.mouse.move(cb.x + 1, cb.y + cb.height / 2);
  await page.mouse.down();
  await page.mouse.move(cb.x + cw * 8, cb.y + cb.height / 2, { steps: 6 });
  await page.mouse.up();
  await page.waitForTimeout(250);
  const copied = await page.evaluate(() => {
    let got = "(copy が発火しない)";
    const ev = new Event("copy", { bubbles: true, cancelable: true });
    Object.defineProperty(ev, "clipboardData", { value: { setData: (_t, v) => (got = v) } });
    document.dispatchEvent(ev);
    return got;
  });
  rule("⑫ 入力欄に打った値を矩形選択→copy で取得できる", copied.includes("COPYTEST"), `"${copied}"`);

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
