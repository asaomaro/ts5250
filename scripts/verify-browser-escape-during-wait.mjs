// **応答待ちの最中に Attn / SysReq で抜けられるか**を実ブラウザ＋実機で確かめる。
//
//   node --env-file=.env --env-file=.env.verify scripts/verify-browser-escape-during-wait.mjs
//
// 画面は期限を設けずに待つ（#388）ので、**固まった要求から抜ける口は Attn / SysReq しか無い**。
// core と ws は施錠中でもフラグキーを通すことを `verify-aid-no-timeout.mjs` で確認済みだが、
// **画面（web-ui）から実際に押せるか**は別問題で、そこは誰も測っていなかった。
//
// 60 秒走る `STSLOOP`（`build-msgloop.mjs`）を呼んで待ちを作り、その最中に:
//
//   1. OIA の「その他」→ **Attn** ボタン           → `key: Attn` が飛ぶか
//   2. OIA の「その他」→ **SysReq** ボタン         → システム要求行が開くか
//   3. その行に **`2`（前の要求の終了）を打てるか** → 打鍵がペインの入力プロテクトに
//      潰されないか（`EmulatorPane.onKeydown` は `inputBlocked` で全キーを
//      `preventDefault` するが、システム要求行の入力はその `.pane` の子である）
//   4. 実行キーで送って、**走っている要求が実際に切れる**か
//
// 前提: npm run build && npm run build -w @ts5250/web-ui 済み。実機に STSLOOP。
import { serve } from "@hono/node-server";
import { WebSocketServer } from "ws";
import { mkdirSync } from "node:fs";
import { buildApp, SessionManager, ServerConfigStore, PersonalConfigStore, ConfigResolver } from "@ts5250/server";
import { SecretCrypto } from "../packages/server/dist/secret-crypto.js";
import { chromium } from "playwright";

const PORT = Number(process.env.ESCAPE_PORT ?? 3492);
const SYSTEM = process.env.AS400_SYSTEM ?? "AS400";
const SESSION = process.env.AS400_SESSION ?? "DEV1";
const LIB = process.env.AS400_LIB ?? "TESTLIB";
const USER = process.env.AS400_USER ?? "";
const PASSWORD = process.env.AS400_PASSWORD ?? "";
const TMP = process.env.ESCAPE_TMP ?? "/tmp/ts5250-escape";
mkdirSync(TMP, { recursive: true });

const log = (s) => process.stderr.write(s + "\n");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok });
  process.stdout.write(`${ok ? "OK  " : "NG  "} ${name}${detail ? " — " + detail : ""}\n`);
};

const crypto = SecretCrypto.fromEnv();
const sessions = new SessionManager();
const resolver = new ConfigResolver(
  ServerConfigStore.fromFile("profiles.local.json", crypto),
  new PersonalConfigStore({ systems: [], sessions: [] }, crypto)
);
const app = buildApp({ sessions, resolver, version: "verify", webRoot: "packages/web-ui/dist" });
const wss = new WebSocketServer({ noServer: true });
const server = serve({ fetch: app.fetch, port: PORT, websocket: { server: wss } });
await sleep(600);

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1600, height: 950 } });
page.on("pageerror", (e) => log("PAGEERR " + e.message));

const t0 = Date.now();
const sent = [];
page.on("websocket", (ws) => {
  ws.on("framesent", ({ payload }) => {
    try {
      const m = JSON.parse(String(payload));
      if (m.type === "key") sent.push({ ms: Date.now() - t0, key: m.key, sysReqText: m.sysReqText });
    } catch {
      /* テキストでないフレームは見ない */
    }
  });
});

const probe = () =>
  page.evaluate(() => ({
    busy: document.querySelector(".busy-overlay") !== null,
    loading: document.querySelector(".busy-overlay.loading") !== null,
    lock: document.querySelector(".oia .lock") !== null,
    sysreqOpen: document.querySelector(".sysreq") !== null,
    sysreqText: document.querySelector(".sysreq .inp")?.value ?? null,
    editable: document.querySelectorAll("input.grid-input:not([readonly])").length,
    grid: document.querySelector(".grid")?.textContent ?? ""
  }));

const shot = async (n) => {
  await page.screenshot({ path: `${TMP}/${n}.png` });
  log(`shot: ${TMP}/${n}.png`);
};

/** OIA のキーパレット（「その他」）の中のボタンを押す */
const padClick = (label) =>
  page.evaluate((lb) => {
    const btn = [...document.querySelectorAll(".oia button.fk")].find((b) => b.textContent.trim() === lb);
    if (!btn) return `ボタンが見つかりません: ${lb}`;
    if (btn.disabled) return `ボタンが無効です: ${lb}`;
    btn.click();
    return "";
  }, label);

let ok = true;
try {
  // ---- 接続 ----
  await page.goto(`http://localhost:${PORT}/`);
  await page.waitForSelector(".launcher", { timeout: 20000 });
  const clickCard = (name, label) =>
    page.evaluate(
      ([nm, lb]) => {
        const body = (el) =>
          [...el.childNodes].filter((n) => n.nodeType === 3).map((n) => n.textContent.trim()).join("");
        const hit = [...document.querySelectorAll(".card")].find(
          (c) => c.querySelector(".nm") && body(c.querySelector(".nm")) === nm
        );
        if (!hit) return `カードが見つかりません: ${nm}`;
        const btn = [...hit.querySelectorAll("button")].find((b) => new RegExp(lb).test(b.textContent ?? ""));
        if (!btn) return `ボタンが見つかりません: ${nm} / ${lb}`;
        btn.click();
        return "";
      },
      [name, label]
    );
  const e1 = await clickCard(SYSTEM, "選択|メニューへ");
  if (e1) throw new Error(e1);
  await page.waitForFunction(
    (nm) =>
      [...document.querySelectorAll(".card .nm")].some(
        (el) => [...el.childNodes].filter((n) => n.nodeType === 3).map((n) => n.textContent.trim()).join("") === nm
      ),
    SESSION,
    { timeout: 10000 }
  );
  const e2 = await clickCard(SESSION, "接続|開く");
  if (e2) throw new Error(e2);
  await page.waitForFunction(() => (document.querySelector(".grid")?.textContent?.length ?? 0) > 100, {
    timeout: 30000
  });
  await sleep(1500);
  for (let i = 0; i < 12; i++) {
    const s = await probe();
    if (/メインメニュー|Main Menu/.test(s.grid)) break;
    await page.locator(".grid").click({ position: { x: 5, y: 5 } });
    if (/対話式ジョブの回復/.test(s.grid)) {
      const el = page.locator("input.grid-input:not([readonly])").last();
      await el.click();
      await page.keyboard.press("Home");
      await page.keyboard.type("90", { delay: 30 });
      await page.keyboard.press("Enter");
    } else if (/パスワード|Password/.test(s.grid) && s.editable >= 2) {
      if (!USER || !PASSWORD) throw new Error("サインオン画面。AS400_USER / AS400_PASSWORD を渡してください");
      const ins = page.locator("input.grid-input:not([readonly])");
      await ins.nth(0).click();
      await page.keyboard.press("Home");
      await page.keyboard.type(USER, { delay: 20 });
      await ins.nth(1).click();
      await page.keyboard.press("Home");
      await page.keyboard.type(PASSWORD, { delay: 20 });
      await page.keyboard.press("Enter");
    } else {
      await page.keyboard.press("Enter");
    }
    await sleep(1800);
  }
  const menu = await probe();
  if (!/メインメニュー|Main Menu/.test(menu.grid)) throw new Error("メインメニューに到達できませんでした");
  check("実機のメインメニューに到達", true, `${SYSTEM} / ${SESSION}`);

  // ---- 60 秒の待ちを作る ----
  const cmdEl = page.locator("input.grid-input:not([readonly])").first();
  await cmdEl.click();
  await page.keyboard.press("Home");
  await page.keyboard.type(`CALL ${LIB}/STSLOOP`, { delay: 15 });
  await page.keyboard.press("Enter");
  await sleep(4000);
  const waiting = await probe();
  check("待ちに入っている（スピナー＋施錠）", waiting.busy && waiting.loading, JSON.stringify({ busy: waiting.busy, loading: waiting.loading, lock: waiting.lock }));
  await shot("01-waiting");

  // ---- 1. キーボード: ペインの打鍵が通るか ----
  // **Attn / SysReq に既定のキー割り当ては無い**（キー設定で任意のキーへ割り当てる）。
  // ここでは代わりに「ペインの keydown が待ち中に生きているか」を見る——生きていなければ、
  // 割り当てたキーもそこへ届かない（`onKeydown` は `inputBlocked` で全キーを潰す）。
  const beforeKb = sent.length;
  await page.locator(".pane").first().click({ position: { x: 400, y: 300 } });
  await page.keyboard.press("F3");
  await sleep(700);
  const kbPassed = sent.length > beforeKb;
  check("1. 待ち中のキーボード打鍵はペインで止められる（既定どおり）", !kbPassed,
    kbPassed ? `F3 が飛んだ: ${JSON.stringify(sent.slice(beforeKb))}` : "F3 は送られない");

  // ---- 2. OIA の Attn ボタン ----
  const openPad = await page.evaluate(() => {
    const btn = [...document.querySelectorAll(".oia button.fk.more")][0];
    if (!btn) return "「その他」ボタンが見つかりません";
    if (!btn.classList.contains("on")) btn.click();
    return "";
  });
  if (openPad) throw new Error(openPad);
  await sleep(400);
  const beforeAttn = sent.length;
  const attnErr = await padClick("Attn");
  await sleep(1500);
  const attnSent = sent.slice(beforeAttn).filter((k) => k.key === "Attn");
  check("2. 待ち中でも OIA の Attn ボタンから送れる", attnErr === "" && attnSent.length === 1,
    attnErr || `送られたキー: ${JSON.stringify(sent.slice(beforeAttn))}`);
  await shot("02-after-attn");

  // ---- 3. SysReq 行を開いて「2」を打てるか ----
  const sysErr = await padClick("SysReq");
  await sleep(600);
  const opened = await probe();
  check("3. 待ち中でも SysReq の行が開く", sysErr === "" && opened.sysreqOpen, sysErr || `sysreqOpen=${opened.sysreqOpen}`);
  // **クリックしない。** 行は開いた時点で自分の入力欄へフォーカスする（`SysReqLine` の watch）。
  // 加えて待ち中は通信中プロテクトの膜（`.busy-overlay`）が全面を覆うので、
  // そもそもマウスでは行に触れない（実測。膜が pointer events を横取りする）
  const focused = await page.evaluate(() => document.activeElement?.id ?? "");
  check("3' 行を開くと入力欄へフォーカスが入る（マウスでは触れない）", focused === "sysreq-input", `activeElement=${focused}`);
  await page.keyboard.type("2", { delay: 50 });
  await sleep(400);
  const typed = await probe();
  check("4. その行に「2」を打ち込める（入力プロテクトに潰されない）", typed.sysreqText === "2",
    `行の中身: ${JSON.stringify(typed.sysreqText)}`);
  await shot("03-sysreq-typed");

  // ---- 4. 実行キーで送って、走っている要求が切れるか ----
  const beforeSys = sent.length;
  await page.keyboard.press("Enter");
  await sleep(4000);
  const sysSent = sent.slice(beforeSys).filter((k) => k.key === "SysReq");
  check("5. SysReq が送られる", sysSent.length === 1, JSON.stringify(sent.slice(beforeSys)));
  check("5' 打った「2」がレコードに載る（載らなければ要求を切れない）",
    sysSent[0]?.sysReqText === "2", `sysReqText=${JSON.stringify(sysSent[0]?.sysReqText)}`);

  // 切れたか（切れれば 60 秒を待たずに待ちが解ける）
  let cancelled = false;
  for (let i = 0; i < 20; i++) {
    const s = await probe();
    if (!s.busy) { cancelled = true; break; }
    await sleep(1000);
  }
  const after = await probe();
  check("6. 走っている要求を切れて、待ちが解ける", cancelled,
    `busy=${after.busy} loading=${after.loading} lock=${after.lock} 入力欄=${after.editable}`);
  await shot("04-after-sysreq");
  log("\n送ったキー: " + JSON.stringify(sent, null, 1));

  // ---- 後始末 ----
  try {
    const c2 = page.locator("input.grid-input:not([readonly])").first();
    await c2.click();
    await page.keyboard.press("Home");
    await page.keyboard.type("SIGNOFF", { delay: 15 });
    await page.keyboard.press("Enter");
    await sleep(2500);
  } catch (e) {
    log("SIGNOFF できなかった: " + (e instanceof Error ? e.message : String(e)));
  }
} catch (err) {
  ok = false;
  log("ERROR: " + (err instanceof Error ? err.stack : String(err)));
  await shot("99-error").catch(() => undefined);
} finally {
  await browser.close().catch(() => undefined);
  server.close?.();
}

const ng = results.filter((r) => !r.ok);
process.stdout.write(`\n${results.length - ng.length}/${results.length} OK\n`);
process.exit(ok && ng.length === 0 ? 0 : 1);
