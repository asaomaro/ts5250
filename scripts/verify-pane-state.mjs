// **開いたタブは閉じるまで生かす**の実ブラウザ検証（`20260802-keep-pane-state`）。
//
// 単体テストで見られるのは「マウントされたままか」「入力が残るか」まで。ここで見るのは
// **画面が壊れていないか**——ペインを包み紙（`.pane-slot`）で括り、`<main>` を 1 つに
// まとめたので、高さの連鎖（`main` → `.ws-root` → `.group` → ペイン）が切れると
// 5250 の画面が縮む。jsdom では検出できない。
//
//   1. タブを行き来しても**打った内容が残る**
//   2. メニューへ寄って戻っても残る／**別のシステムを選んで戻っても残る**
//   3. その間ずっと **5250 の画面の大きさが変わらない**（高さの連鎖が切れていない）
//   4. 一度も開いていないタブは**マウントされていない**
//
// 実行: node --env-file=.env scripts/verify-pane-state.mjs
//   （事前に `npm run build` と `npm run build -w @ts5250/web-ui` が要る）
//
// 副作用: 実機へ表示セッションを 1 本張って画面を読むだけ。装置名は指定せずホストに採らせる。
// 2 つ目のシステム（切替の相手）は**接続しない**ので、同じホストを指しても増える接続は無い。
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
const PORT = Number(process.env.PORT ?? 3491);
const TYPED = "KEEPME";

const log = (s) => process.stdout.write(s + "\n");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0;
let fail = 0;
const check = (cond, msg) => {
  if (cond) { pass++; log(`  PASS ${msg}`); } else { fail++; log(`  FAIL ${msg}`); }
};

const work = mkdtempSync(join(tmpdir(), "panestate-"));
const cfgPath = join(work, "profiles.json");
// **パスワードはファイルに書かない**——`passwordEnv` で環境変数を指す
writeFileSync(
  cfgPath,
  JSON.stringify({
    systems: [
      { id: "AS400", name: "AS400", host, ccsid: 5035, signon: { user, passwordEnv: "AS400_PASSWORD" } },
      // 切替の相手。**繋がない**（タブを開かないので接続は起きない）
      { id: "OTHER", name: "OTHER", host, ccsid: 5035, signon: { user, passwordEnv: "AS400_PASSWORD" } }
    ],
    sessions: [{ id: "DSP", name: "DSP", system: "AS400", sessionType: "display" }]
  })
);

const crypto = SecretCrypto.fromEnv();
const resolver = new ConfigResolver(
  ServerConfigStore.fromFile(cfgPath, crypto),
  new PersonalConfigStore({ systems: [], sessions: [] }, crypto)
);
const sessions = new SessionManager();
const app = buildApp({ sessions, resolver, version: "verify", webRoot: "packages/web-ui/dist" });
const wss = new WebSocketServer({ noServer: true });
const server = serve({ fetch: app.fetch, port: PORT, websocket: { server: wss } });
await sleep(600);

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });

/** 5250 の画面の実寸（フォント px と桁幅）。高さの連鎖が切れると縮む */
const gridSize = () =>
  page.evaluate(() => {
    const g = document.querySelector(".grid");
    if (!g) return null;
    const r = g.getBoundingClientRect();
    return { font: parseFloat(getComputedStyle(g).fontSize), w: Math.round(r.width), h: Math.round(r.height) };
  });
/** データ転送タブの最初の入力欄の値（隠れていても DOM から読める＝生きている証拠） */
const typedValue = () =>
  page.evaluate(() => {
    const el = document.querySelector(".pane-slot[data-tab='transfer:data'] input");
    return el ? el.value : null;
  });
/** メニュー（ランチャー）へ／ワークスペースへ */
const goto = (label) => page.locator(".crumbs .crumb", { hasText: label }).click();
/** データ転送タブを含むペイン（分割後にどちら側か決め打たない） */
const transferGroup = () =>
  page.locator(".group").filter({ has: page.locator(".pane-slot[data-tab='transfer:data']") }).first();
/**
 * タブを掴んで画面上の座標へ落とす。
 * **`dragAndDrop` は使わない**——HTML5 の DnD はマウスを動かさないと `dragover` が
 * 出ず、落とし場所（端 4 ゾーン／タブ帯）の判定が走らない。
 */
async function dragTabTo(label, x, y) {
  await page.locator(".tabs .tab", { hasText: label }).first().hover();
  await page.mouse.down();
  await page.mouse.move(x, y, { steps: 12 });
  await page.mouse.move(x, y, { steps: 2 }); // 最後にもう一度動かして dragover を確実に出す
  await page.mouse.up();
  await sleep(900);
}

try {
  await page.goto(`http://127.0.0.1:${PORT}/`);
  await page.waitForSelector(".launcher", { timeout: 15_000 });
  const pick = page.locator(".card", { hasText: "AS400" }).first().locator("button", { hasText: "選択" });
  if (await pick.count()) { await pick.click(); await sleep(400); }

  // ---- 5250 を開く（高さの連鎖を測る足場） ----
  log("### 5250 を開く");
  await page.locator(".card", { hasText: "DSP" }).first().locator("button", { hasText: /^(接続|開く)$/ }).click();
  await page.waitForFunction(() => (document.querySelector(".grid")?.textContent?.length ?? 0) > 400, { timeout: 40_000 });
  await sleep(1200);
  const base = await gridSize();
  check(base !== null && base.font > 10, `画面が広がっている（フォント ${base?.font}px / ${base?.w}x${base?.h}）`);

  // ---- データ転送タブを開いて打つ ----
  log("\n### データ転送タブに打つ");
  await goto("メニュー");
  await page.waitForSelector(".launcher", { timeout: 10_000 });
  await page.locator(".fn", { hasText: "データ転送" }).first().locator("button").first().click();
  await page.waitForSelector(".pane-slot[data-tab='transfer:data']", { timeout: 10_000 });
  await page.locator(".pane-slot[data-tab='transfer:data'] input").first().fill(TYPED);
  check((await typedValue()) === TYPED, "打った内容が入っている");
  check(
    (await page.locator(".pane-slot[data-tab='ifs:files']").count()) === 0,
    "**一度も開いていないタブは作っていない**（起動時に全部問い合わせない）"
  );

  // ---- タブを行き来する ----
  log("\n### タブを行き来する");
  await page.locator(".tabs .tab", { hasText: "DSP" }).first().click();
  await sleep(500);
  check((await typedValue()) === TYPED, "**別のタブへ移っても残る**");
  const afterTab = await gridSize();
  check(afterTab?.font === base?.font && afterTab?.h === base?.h, `画面の大きさが変わらない（${afterTab?.font}px / ${afterTab?.w}x${afterTab?.h}）`);

  // ---- メニューへ寄って戻る ----
  log("\n### メニューへ寄って戻る");
  await goto("メニュー");
  await page.waitForSelector(".launcher", { timeout: 10_000 });
  check((await typedValue()) === TYPED, "**メニューへ寄っても残る**");
  await goto("ワークスペース");
  await sleep(600);
  const afterMenu = await gridSize();
  check((await typedValue()) === TYPED, "戻っても残る");
  check(afterMenu?.font === base?.font && afterMenu?.h === base?.h, `画面の大きさが戻る（${afterMenu?.font}px / ${afterMenu?.w}x${afterMenu?.h}）`);

  // ---- 別のシステムを選んで戻る ----
  log("\n### 別のシステムを選んで戻る");
  await goto("システム");
  await page.waitForSelector(".launcher", { timeout: 10_000 });
  await page.locator(".card", { hasText: "OTHER" }).first().locator("button", { hasText: "選択" }).click();
  await sleep(700);
  check((await typedValue()) === TYPED, "**別のシステムを選んでも残る**");
  await goto("システム");
  await page.locator(".card", { hasText: "AS400" }).first().locator("button", { hasText: "選択" }).click();
  await sleep(900);
  check((await typedValue()) === TYPED, "戻っても残る");
  // システムを選び直した直後はメニューに居る（そこは従来どおり）。画面の大きさは
  // ワークスペースへ戻してから測る——隠れている間は 0x0 で当たり前
  await goto("ワークスペース");
  await sleep(700);
  const afterSys = await gridSize();
  check(afterSys?.font === base?.font && afterSys?.h === base?.h, `画面の大きさが戻る（${afterSys?.font}px / ${afterSys?.w}x${afterSys?.h}）`);

  // ---- 分割する（データ転送のタブを右端へ落とす） ----
  // ここから先は `20260802-keep-pane-state-move`。実体は `PanePool` が持ち受け皿へ
  // Teleport するので、木を組み替えても作り直されない——それを実物で確かめる。
  log("\n### 分割する");
  const paneBox = await page.locator(".group").first().boundingBox();
  await dragTabTo("データ転送", paneBox.x + paneBox.width * 0.9, paneBox.y + paneBox.height * 0.5);
  const groups = await page.locator(".group").count();
  check(groups === 2, `2 つのペインに割れる（${groups}）`);
  check((await typedValue()) === TYPED, "**分割しても打った内容が残る**");

  // ---- 最大化・解除 ----
  log("\n### 最大化・解除");
  const before = await transferGroup().boundingBox();
  await transferGroup().locator("button.maximize").click();
  await sleep(700);
  const maxed = await transferGroup().boundingBox();
  check(maxed.width > before.width * 1.5, `**最大化で全面になる**（${Math.round(before.width)} → ${Math.round(maxed.width)}px）`);
  check((await typedValue()) === TYPED, "最大化しても残る");
  check((await page.locator(".grid").count()) === 1, "隠した側も作り直されていない（5250 の要素が残っている）");

  await transferGroup().locator("button.maximize").click();
  await sleep(700);
  const restored = await transferGroup().boundingBox();
  check(Math.abs(restored.width - before.width) < 4, `解除で元の比率に戻る（${Math.round(restored.width)}px）`);
  check((await typedValue()) === TYPED, "**解除しても残る**");

  // ---- タブを別のペインへ移す ----
  log("\n### タブを別のペインへ移す");
  const destTabs = page
    .locator(".group")
    .filter({ hasNot: page.locator(".pane-slot[data-tab='transfer:data']") })
    .first()
    .locator(".tabs");
  const dest = await destTabs.boundingBox();
  await dragTabTo("データ転送", dest.x + dest.width * 0.5, dest.y + dest.height * 0.5);
  check((await typedValue()) === TYPED, "**別のペインへ移しても残る**");
} catch (e) {
  fail++;
  log(`  FAIL 例外: ${e?.message ?? e}`);
  try {
    const t = await page.locator("body").innerText();
    log("  --- 画面 ---\n" + t.split("\n").slice(0, 30).map((l) => "  | " + l).join("\n"));
  } catch { /* 良い */ }
} finally {
  await browser.close().catch(() => {});
  for (const s of sessions.list()) {
    try { await sessions.close(s.id); } catch { /* 良い */ }
  }
  server.close();
  wss.close();
  try { rmSync(work, { recursive: true, force: true }); } catch { /* 良い */ }
}

log(`\n${fail === 0 ? "OK" : "NG"} — ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
