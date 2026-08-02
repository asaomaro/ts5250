// **「外観」と「表示」／表示設定の 2 段カスケード**の実機検証
// （`20260802-appearance-and-view-cascade` ＋ `20260802-view-menu-refine`）。
//
// jsdom は CSS を計算しないので、ここでしか見られないものが 2 つある:
//
//   1. **移行で見え方が変わらない**——テーマのブロックを「差分を当てる」形から
//      「自己完結」へ書き換え、選択子から `:root` を外した。特定度が (0,2,0) → (0,1,0) へ
//      下がるので、**ルートでの優先関係が本当に保たれているか**は実画素で見るしかない。
//   2. **ヘッダーのボタンの高さが揃っている**（キー・HTML・マクロ・表示・外観）。
//   3. **「既定に従う」の選択肢が無く、既定の値にだけ印が付く**。
//
// テーマのセッション個別指定は `20260802-view-menu-refine` で**廃止**した（利用者の判断）。
// エミュレータ画面は外観（スキン・表示モード）に従う——そのために入れた CSS の作り替えも
// 巻き戻したので、**地色が元のままか**を 1 で見ている。
//
// 実行: node --env-file=.env scripts/verify-view-cascade.mjs
//   （事前に `npm run build` と `npm run build -w @ts5250/web-ui` が要る）
//
// 副作用: 実機へ表示セッションを 1 本張って画面を読むだけ。装置名は指定せずホストに採らせる。
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

  // ---- 3. ヘッダーのボタンの高さが揃っている ----
  log("\n### ヘッダーのボタンの高さ");
  const heights = await page.evaluate(() =>
    Array.from(document.querySelectorAll(".toggles button, .toggles .designer > button")).map((b) => ({
      text: (b.textContent ?? "").trim().replace(/\s+/g, " "),
      h: Math.round(b.getBoundingClientRect().height)
    }))
  );
  const uniq = [...new Set(heights.map((x) => x.h))];
  check(
    uniq.length === 1,
    `**5 つとも同じ高さ**（${heights.map((x) => `${x.text}:${x.h}`).join(" / ")}）`
  );

  // ---- 4. 「既定に従う」が無く、既定に印が付く ----
  log("\n### 既定の示し方");
  /**
   * `⚙ 表示` を開き、`このセッション` 層にする。
   * **開くまで押す**——開閉はトグルなので、既に開いていると 1 回目が「閉じる」になる。
   * ボタンは**ページの中で探して押す**（Playwright の `hasText` はテンプレート由来の
   * 改行が入るボタンで当たらないことがある）。
   */
  for (let i = 0; i < 2 && (await page.locator(".vsm-menu").count()) === 0; i++) {
    await page.locator(".vsm-btn").click();
    await sleep(400);
  }
  await page.waitForSelector(".vsm-menu", { timeout: 5000 });
  await page.evaluate(() => {
    const rows = Array.from(document.querySelectorAll(".vsm-row"));
    const row = rows.find((r) => r.querySelector(".vsm-label")?.textContent?.includes("設定の対象"));
    const btn = Array.from(row?.querySelectorAll(".seg button") ?? []).find((b) =>
      (b.textContent ?? "").trim().startsWith("このセッション")
    );
    btn?.click();
  });
  await sleep(300);
  const opts = await page.evaluate(() => {
    const rows = Array.from(document.querySelectorAll(".vsm-row"));
    const row = rows.find((r) => r.querySelector(".vsm-label")?.textContent?.includes("画面の質感"));
    return Array.from(row?.querySelectorAll(".seg button") ?? []).map((b) => ({
      text: (b.textContent ?? "").trim(),
      def: !!b.querySelector(".vsm-def"),
      on: b.classList.contains("on")
    }));
  });
  check(!opts.some((o) => o.text.includes("既定に従う")), "**「既定に従う」の選択肢が無い**");
  check(opts.filter((o) => o.def).length === 1, `**既定の値にだけ印が付く**（${opts.map((o) => o.text + (o.def ? "·" : "")).join(" / ")}）`);
  check(opts.some((o) => o.def && o.on), "継承中は既定の値が選択状態に見える");

  // ---- 5. 帳票の画面（スプール）にも「表示」が出る ----
  log("\n### 帳票の画面の表示設定");
  await page.locator(".crumbs .crumb", { hasText: "メニュー" }).click();
  await page.waitForSelector(".launcher", { timeout: 10_000 });
  await page.locator(".fn", { hasText: "スプール" }).first().locator("button").first().click();
  await sleep(900);
  check((await page.locator(".vsm-btn").count()) === 1, "**スプールでも `⚙ 表示` が出る**");
  for (let i = 0; i < 2 && (await page.locator(".vsm-menu").count()) === 0; i++) {
    await page.locator(".vsm-btn").click();
    await sleep(400);
  }
  const spoolLabels = await page.evaluate(() =>
    Array.from(document.querySelectorAll(".vsm-menu .vsm-label")).map((l) => (l.textContent ?? "").trim())
  );
  check(spoolLabels.includes("リンク化"), `リンク化が出る（${spoolLabels.join(" / ")}）`);
  check(spoolLabels.some((l) => l.startsWith("フォント")), "フォントが出る");
  check(
    !spoolLabels.some((l) => l.startsWith("SO/SI") || l.startsWith("表示コード")),
    "**効かない項目（SO/SI・表示コード）は出さない**"
  );

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
