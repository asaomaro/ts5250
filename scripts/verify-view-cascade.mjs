// **「外観」と「表示」／表示設定の 2 段カスケード**の実機検証
// （`20260802-appearance-and-view-cascade`）。
//
// jsdom は CSS を計算しないので、ここでしか見られないものが 2 つある:
//
//   1. **移行で見え方が変わらない**——テーマのブロックを「差分を当てる」形から
//      「自己完結」へ書き換え、選択子から `:root` を外した。特定度が (0,2,0) → (0,1,0) へ
//      下がるので、**ルートでの優先関係が本当に保たれているか**は実画素で見るしかない。
//   2. **セッション個別のテーマがペインの中だけに効く**——`.pane` に `data-theme` を付ける。
//      タブ帯・ヘッダーまで変わっていないことを、実際の背景色で確かめる。
//
// 実行: node --env-file=.env scripts/verify-view-cascade.mjs
//   （事前に `npm run build` と `npm run build -w @as400web/web-ui` が要る）
//
// 副作用: 実機へ表示セッションを 1 本張って画面を読むだけ。装置名は指定せずホストに採らせる。
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serve } from "@hono/node-server";
import { WebSocketServer } from "ws";
import { buildApp, SessionManager, ServerConfigStore, PersonalConfigStore, ConfigResolver } from "@as400web/server";
import { SecretCrypto } from "../packages/server/dist/secret-crypto.js";
import { chromium } from "playwright";

const host = process.env.AS400_HOST;
const user = process.env.AS400_USER;
if (!host || !user || !process.env.AS400_PASSWORD) {
  process.stderr.write("AS400_HOST / AS400_USER / AS400_PASSWORD を環境変数で渡してください\n");
  process.exit(2);
}
const PORT = Number(process.env.PORT ?? 3493);

const log = (s) => process.stdout.write(s + "\n");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0;
let fail = 0;
const check = (cond, msg) => {
  if (cond) { pass++; log(`  PASS ${msg}`); } else { fail++; log(`  FAIL ${msg}`); }
};

const work = mkdtempSync(join(tmpdir(), "viewcas-"));
const cfgPath = join(work, "profiles.json");
// **パスワードはファイルに書かない**——`passwordEnv` で環境変数を指す
writeFileSync(
  cfgPath,
  JSON.stringify({
    systems: [{ id: "AS400", name: "AS400", host, ccsid: 5035, signon: { user, passwordEnv: "AS400_PASSWORD" } }],
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

/** 画面の地色・タブ帯の地色・ヘッダーの地色をまとめて採る */
const colors = () =>
  page.evaluate(() => {
    const bg = (sel) => {
      const el = document.querySelector(sel);
      return el ? getComputedStyle(el).backgroundColor : null;
    };
    const grid = document.querySelector(".grid");
    return {
      grid: grid ? getComputedStyle(grid).backgroundColor : null,
      gridInk: grid ? getComputedStyle(grid).color : null,
      // **`.tabs` ではなく `.tab`。** 帯そのものは透過なので、漏れたかどうかを測れない。
      // タブは `var(--crt)` を地色にしているので、テーマがペインの外へ漏れれば必ず動く
      tabs: bg(".tabs .tab"),
      header: bg(".dz-btn")
    };
  });

try {
  await page.goto(`http://127.0.0.1:${PORT}/`);
  await page.waitForSelector(".launcher", { timeout: 15_000 });
  const pick = page.locator(".card", { hasText: "AS400" }).first().locator("button", { hasText: "選択" });
  if (await pick.count()) { await pick.click(); await sleep(400); }
  await page.locator(".card", { hasText: "DSP" }).first().locator("button", { hasText: /^(接続|開く)$/ }).click();
  await page.waitForFunction(() => (document.querySelector(".grid")?.textContent?.length ?? 0) > 400, { timeout: 40_000 });
  await sleep(1200);

  // ---- 1. 移行しても見え方が変わらない ----
  log("### 移行（テーマのブロックを書き換えた影響）");
  const base = await colors();
  log(`  基準値: 画面 ${base.grid} / 文字 ${base.gridInk} / タブ帯 ${base.tabs} / ヘッダー ${base.header}`);
  // **書き換え前の値と突き合わせる。** `AS400_BASELINE_GRID` に前の版で測った地色を渡すと、
  // 移行で見え方が変わっていないことを機械的に確かめられる（渡さなければ記録だけ）。
  const baseline = process.env.AS400_BASELINE_GRID;
  if (baseline) {
    check(base.grid === baseline, `**移行しても画面の地色が変わらない**（前 ${baseline} / 後 ${base.grid}）`);
  } else {
    log("  SKIP 移行前との突き合わせ（AS400_BASELINE_GRID 未指定）");
  }
  check(base.grid !== null, "画面の地色を測れている");

  // ---- 2. 名前 ----
  log("\n### メニューの名前");
  check((await page.locator(".dz-btn").innerText()).trim() === "外観", "ヘッダーのボタンが `外観`");
  check((await page.locator(".vsm-btn").innerText()).trim() === "⚙ 表示", "エミュレータのボタンが `⚙ 表示`");

  // ---- 3. セッション個別のテーマはペインの中だけ ----
  log("\n### セッション個別のテーマ");
  /**
   * `表示` メニューの行のボタンを押す。**ページの中で探して押す**——
   * Playwright の `hasText` は空白の扱いが素直でなく、テンプレート由来の改行が入る
   * ボタン（`既定に従う（…）`）で当たらないことがある。ここは検証の本題ではないので、
   * 曖昧さの無い方法で押す。
   */
  const clickRowButton = (label, startsWith) =>
    page.evaluate(
      ({ label, startsWith }) => {
        const rows = Array.from(document.querySelectorAll(".vsm-row"));
        const row = rows.find((r) => r.querySelector(".vsm-label")?.textContent?.includes(label));
        if (!row) throw new Error(`行が無い: ${label}`);
        const btn = Array.from(row.querySelectorAll(".seg button")).find((b) =>
          (b.textContent ?? "").trim().startsWith(startsWith)
        );
        if (!btn) throw new Error(`ボタンが無い: ${label} / ${startsWith}`);
        btn.click();
      },
      { label, startsWith }
    );
  /**
   * `⚙ 表示` を開き、`このセッション` 層にする。
   * **開くまで押す**——開閉はトグルなので、既に開いていると 1 回目のクリックが「閉じる」になる。
   */
  async function openViewMenu() {
    for (let i = 0; i < 2 && (await page.locator(".vsm-menu").count()) === 0; i++) {
      await page.locator(".vsm-btn").click();
      await sleep(400);
    }
    await page.waitForSelector(".vsm-menu", { timeout: 5000 });
    await clickRowButton("設定の対象", "このセッション");
    await sleep(300);
  }
  await openViewMenu();
  // **アプリの実効テーマと逆を選ぶ。** 同じ側を選んでも色が動かず、検査にならない
  // （headless Chromium は `prefers-color-scheme: light` を返すので既定は通常）。
  const opposite = await page.evaluate(() =>
    document.documentElement.getAttribute("data-theme") === "dark" ? "通常" : "ダーク"
  );
  await clickRowButton("テーマ", opposite);
  await sleep(600);

  const after = await colors();
  check(after.grid !== base.grid, `**画面の地色が変わる**（${base.grid} → ${after.grid}）`);
  check(after.tabs === base.tabs, `**タブ帯は変わらない**（${base.tabs} → ${after.tabs}）`);
  check(after.header === base.header, `**ヘッダーも変わらない**（${base.header} → ${after.header}）`);

  // ---- 4. 既定に戻す ----
  log("\n### 既定に戻す");
  await openViewMenu();
  await clickRowButton("テーマ", "既定に従う");
  await sleep(600);
  const back = await colors();
  check(back.grid === base.grid, `**戻すと元の地色に戻る**（${back.grid}）`);
  check(back.gridInk === base.gridInk, `文字色も戻る（${back.gridInk}）`);
} catch (e) {
  fail++;
  log(`  FAIL 例外: ${e?.message ?? e}`);
  try {
    const t = await page.locator("body").innerText();
    log("  --- 画面 ---\n" + t.split("\n").slice(0, 25).map((l) => "  | " + l).join("\n"));
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
