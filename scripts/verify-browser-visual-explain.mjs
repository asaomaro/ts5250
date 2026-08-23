/**
 * 実行計画の画面検証（実ブラウザ・実機）。
 *
 *   node --env-file=.env scripts/verify-browser-visual-explain.mjs
 *
 * 単体テストは偽 `fetch` で動かしているので、**実ホストから返る本物の計画で画面が成立するか**は
 * ここでしか分からない（ノード数・ラベル・SVG の描画・一覧ペイン）。
 *
 * 見るもの:
 *   - SQL ペインの「実行して計画」「行を返さず計画」で計画パネルが出る
 *   - グラフ（SVG）に**ステップだけ**が描かれ、付帯情報は脇に出る
 *   - ノードを選ぶと属性が出る
 *   - ツリーに切り替えても同じノードが見える
 *   - 索引の助言に `CREATE INDEX` 文が出る（**押さない**——作成は破壊的操作）
 *   - 「実行計画」ペインでプランキャッシュの一覧→計画表示
 *   - 実行履歴・保存・JSON 書き出し
 */
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { serve } from "@hono/node-server";
import { WebSocketServer } from "ws";
import {
  buildApp,
  SessionManager,
  ServerConfigStore,
  PersonalConfigStore,
  ConfigResolver
} from "@ts5250/server";
import { chromium } from "playwright";

const log = (s) => process.stderr.write(s + "\n");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const PORT = 3491;
const TMP = process.env.VE_TMP ?? "/tmp/as400-verify-ve-browser";
const SHOTS = `${TMP}/shots`;
mkdirSync(SHOTS, { recursive: true });

const results = [];
const check = (n, ok, d = "") => {
  results.push({ n, ok });
  process.stdout.write(`${ok ? "OK  " : "NG  "} ${n}${d ? ` — ${d.slice(0, 160)}` : ""}\n`);
};

if (!process.env["AS400_PASSWORD"]) {
  log("AS400_PASSWORD が未設定です");
  process.exit(1);
}

// 設定の置き場は差し替えられる（個人の `connections.json` に実機が無い環境でも走らせるため）
const cfg = JSON.parse(readFileSync(process.env.VE_CONN ?? "connections.json", "utf8"));
const sys = cfg.systems.find((s) => s.name === (process.env.AS400_SYSTEM ?? "AS400"));
// **値はファイルに落とさない**（環境変数の名前だけ）
sys.signon = { user: sys.signon.user, passwordEnv: "AS400_PASSWORD" };
const tmpCfg = `${TMP}/conn.json`;
writeFileSync(tmpCfg, JSON.stringify(cfg));

const resolver = new ConfigResolver(
  ServerConfigStore.fromFile(tmpCfg),
  new PersonalConfigStore({ systems: [], sessions: [] })
);
const app = buildApp({
  sessions: new SessionManager(),
  resolver,
  version: "verify",
  webRoot: "packages/web-ui/dist"
});
const wss = new WebSocketServer({ noServer: true });
const server = serve({ fetch: app.fetch, port: PORT, websocket: { server: wss } });
await sleep(600);

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1600, height: 950 } });
page.on("pageerror", (e) => log("PAGEERR " + e.message));
const shot = async (name) => {
  await page.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: false });
  log(`shot: ${SHOTS}/${name}.png`);
};

/**
 * 検証に使う文。**差し替えられる**（`VE_SQL`）——手続きの `CALL` でも計画が採れることを
 * 見たいときに使う。
 *
 * ⚠ **差し替えると後半の項目は当てにならない。** 索引の助言・「行を返さず計画」・
 * 実行履歴の件数は、この既定の SELECT が出すものを前提に書いてある
 * （`CALL` は助言が出ず、行を返さないモードは SELECT 系のみ）。回帰として数えるのは
 * 既定のまま走らせたときだけ。
 */
const SQL = process.env.VE_SQL ?? "SELECT COUNT(*) AS N FROM QSYS2.SYSCOLUMNS WHERE TABLE_SCHEMA = 'QSYS2'";

/** 計画パネルが出る（または誤りが出る）まで待つ */
async function waitPlan() {
  await page
    .waitForFunction(() => document.querySelector(".plan-view .plan-viewer, .plan-view .plan-error") !== null, {
      timeout: 60000
    })
    .catch(() => undefined);
  await sleep(500);
}

try {
  await page.goto(`http://localhost:${PORT}/`);
  await page.waitForSelector(".launcher", { timeout: 20000 });
  // **システムが 1 つだけならアプリが自動で選ぶ**（選択画面が出ない）
  const pick = page.locator(".card:has-text('実機') >> button:has-text('選択')");
  if ((await pick.count()) > 0) await pick.first().click();
  await page.waitForSelector(".fn:has-text('SQL')", { timeout: 10000 });

  // ---- 1. SQL ペインからの導線 ----
  await page.click(".fn:has-text('SQL') >> button");
  await page.waitForSelector(".sql-pane textarea", { timeout: 15000 });
  await page.locator(".sql-pane textarea").fill(SQL);
  await shot("01-sql-pane");

  const btns = await page.locator(".sql-pane header button").allInnerTexts();
  check("2 つのモードのボタンが出る", btns.includes("実行して計画") && btns.includes("行を返さず計画"), btns.join(" / "));
  const noRowsTitle = await page.locator(".sql-pane header button:has-text('行を返さず計画')").getAttribute("title");
  check("**「実行しない」と書かず、実行される旨を書く**",
    Boolean(noRowsTitle?.includes("文はホストで実行されます")) && !noRowsTitle?.includes("実行しない"), String(noRowsTitle));

  await page.click(".sql-pane header button:has-text('実行して計画')");
  await waitPlan();
  await shot("02-plan-graph");

  const panel = page.locator(".plan-view");
  check("計画タブが出る", await panel.isVisible());
  const err = await page.locator(".plan-view .plan-error").count();
  check("誤りが出ていない", err === 0, err > 0 ? await page.locator(".plan-view .plan-error").innerText() : "");

  // ---- 2. グラフの描画 ----
  const svgNodes = await page.locator(".plan-view svg g.pg-node").count();
  check("**SVG にノードが描かれている**", svgNodes > 0, `${svgNodes} ノード`);
  const stepText = await page.locator(".plan-view .pv-summary").innerText();
  check("要約にステップ数とノード計が出る", stepText.includes("ステップ") && stepText.includes("ノード計"), stepText.replace(/\n/gu, " "));

  const labels = (await page.locator(".plan-view svg g.pg-node text.pg-label").allTextContents()).map((t) => t ?? "");
  check("**記録種別に名前が付いている**（「記録 nnnn」だけではない）",
    labels.some((t) => t.includes("表の走査") || t.includes("索引の使用")), labels.join(" / "));
  check("図に付帯情報を出していない",
    !labels.some((t) => t.includes("クエリ情報") || t.includes("アクセスプランの再作成")), labels.join(" / "));

  // ---- 3. ノードを選ぶと属性が出る ----
  await page.locator(".plan-view svg g.pg-node").first().click();
  await sleep(300);
  // **複数の組に分かれて出る**（表・索引 / 見積もり / モニターの全列）ので、
  // 1 つに絞らず全部つないで見る——絞ると Playwright の strict 判定で落ちる
  const attrs = (await page.locator(".plan-view .pv-attrs").allInnerTexts()).join("\n");
  check("ノードを選ぶと属性が出る", attrs.includes("記録種別"), attrs.replace(/\n/gu, " ").slice(0, 120));
  await shot("03-node-selected");

  // ---- 4. ツリー表示 ----
  await page.click(".plan-view button:has-text('ツリー')");
  await sleep(300);
  const treeNodes = await page.locator(".plan-view .pv-tree-node").count();
  check("ツリーに切り替わり、同じ数のノードが出る", treeNodes === svgNodes, `tree=${treeNodes} / svg=${svgNodes}`);
  await shot("04-plan-tree");
  await page.click(".plan-view button:has-text('グラフ')");

  // ---- 5. 付帯情報と索引助言 ----
  const side = await page.locator(".plan-view .pv-side").innerText();
  check("付帯情報が脇に出る", side.includes("付帯情報"), side.replace(/\n/gu, " ").slice(0, 120));
  check("索引の助言に CREATE INDEX 文が出る", side.includes("CREATE INDEX"), side.replace(/\n/gu, " ").slice(0, 200));
  // **押さない**（索引の作成は破壊的操作。ボタンが在ることだけ確かめる）
  check("作成ボタンが在る（押さない）", (await page.locator(".plan-view button:has-text('この索引を作成')").count()) > 0);

  // ---- 6. 行を返さず計画 ----
  await page.click(".sql-pane header button:has-text('行を返さず計画')");
  await waitPlan();
  const meta = await page.locator(".plan-view .pv-meta").innerText().catch(() => "");
  check("**行を返さず計画**でも計画が出る", meta.includes("行を返さず計画"), meta.replace(/\n/gu, " ").slice(0, 120));
  await shot("05-no-rows");

  // ---- 7. 実行計画ペイン ----
  await page.click(".launcher-btn, .breadcrumb button, header button:has-text('メニュー')").catch(() => undefined);
  await page.waitForSelector(".launcher", { timeout: 10000 }).catch(() => undefined);
  if ((await page.locator(".fn:has-text('実行計画')").count()) === 0) {
    check("ランチャーに「実行計画」がある", false, "見つからない");
  } else {
    check("ランチャーに「実行計画」がある", true);
    await page.click(".fn:has-text('実行計画') >> button");
    await page.waitForSelector(".plan-list", { timeout: 20000 });
    await page.waitForFunction(() => document.querySelectorAll(".plan-list .pl-item").length > 0 || document.querySelector(".plan-list .pl-unavailable") !== null, { timeout: 60000 }).catch(() => undefined);
    await sleep(500);
    await shot("06-plan-list");

    const listText = await page.locator(".plan-list").innerText();
    check("一覧ペインが開き、ソース切替が出る",
      listText.includes("プランキャッシュ") && listText.includes("実行履歴") && listText.includes("保存済み"),
      listText.replace(/\n/gu, " ").slice(0, 140));
    const items = await page.locator(".plan-list .pl-item").count();
    check("プランキャッシュの一覧が出る（全特権の機）", items > 0, `${items} 件`);

    if (items > 0) {
      await page.locator(".plan-list .pl-item").first().click();
      await page.waitForSelector(".plan-list .plan-viewer", { timeout: 40000 }).catch(() => undefined);
      await sleep(600);
      const viewer = await page.locator(".plan-list .pl-viewer").innerText();
      check("一覧から計画を開ける", viewer.includes("プランキャッシュ"), viewer.replace(/\n/gu, " ").slice(0, 140));
      await shot("07-plan-from-cache");
    }

    // 実行履歴（SQL ペインで採った 2 件が入っているはず）
    await page.click(".plan-list button:has-text('実行履歴')");
    await sleep(400);
    const hist = await page.locator(".plan-list .pl-item").count();
    check("**実行履歴に採った計画が入っている**", hist >= 2, `${hist} 件`);
    await page.locator(".plan-list .pl-item").first().click();
    await sleep(400);
    await page.click(".plan-list button:has-text('この計画を保存')");
    await sleep(300);
    const noticeText = await page.locator(".plan-list").innerText();
    check("保存すると知らせが出る", noticeText.includes("保存しました"), noticeText.replace(/\n/gu, " ").slice(0, 140));
    await shot("08-history-saved");
  }
} catch (e) {
  check("例外なく完走する", false, String(e));
} finally {
  await browser.close();
  server.close();
  wss.close();
}

const ng = results.filter((r) => !r.ok).length;
process.stdout.write(`\n=== ${results.length} 件中 失敗 ${ng} 件 ===\nスクリーンショット: ${SHOTS}\n`);
if (!existsSync(SHOTS)) process.stdout.write("（スクリーンショットなし）\n");
process.exit(ng === 0 ? 0 : 1);
