// **異なるシステムのタブを並べて同時に見る**の実機検証（`20260802-tabs-own-system`）。
//
// 単体テストは偽 fetch で宛先を見ている。ここで見るのは**本物の往復**:
//
//   1. A の SQL と B の SQL が**別のタブ**として並ぶ（以前は SQL タブが 1 枚しか置けなかった）
//   2. **それぞれの要求が自分のシステムへ飛ぶ**（実際の HTTP の body を覗いて確かめる）
//   3. 2 システム開いているときだけタブに**システム名**が出て、**色帯**が付く
//   4. システムを選び直しても**タブが 1 枚も消えない**（以前は絞り込みで隠れていた）
//   5. **ヘッダーが常に見ているタブのシステムを映す**（タブを選び替えただけで変わる）
//
// 実行: node --env-file=.env scripts/verify-tabs-own-system.mjs
//   （事前に `npm run build` と `npm run build -w @ts5250/web-ui` が要る）
//
// 副作用: **SQL を 2 回投げるだけ**（`SYSIBM.SYSDUMMY1` の SELECT）。
// 2 つのシステム設定は同じホストを指す——増える接続はプールが面倒を見る範囲で、
// オブジェクトは何も作らない。
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
const PORT = Number(process.env.PORT ?? 3492);
const REF_A = "srv:SYSA";
const REF_B = "srv:SYSB";

const log = (s) => process.stdout.write(s + "\n");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0;
let fail = 0;
const check = (cond, msg) => {
  if (cond) { pass++; log(`  PASS ${msg}`); } else { fail++; log(`  FAIL ${msg}`); }
};

const work = mkdtempSync(join(tmpdir(), "tabsys-"));
const cfgPath = join(work, "profiles.json");
// **パスワードはファイルに書かない**——`passwordEnv` で環境変数を指す。
// 2 つのシステムは同じホストを指す（切替の相手が要るだけ）。色は決め打ちにして、
// 自動割り当てが偶然ぶつかっても検証が揺れないようにする
writeFileSync(
  cfgPath,
  JSON.stringify({
    systems: [
      { id: "SYSA", name: "エー", host, ccsid: 5035, color: 1, signon: { user, passwordEnv: "AS400_PASSWORD" } },
      { id: "SYSB", name: "ビー", host, ccsid: 5035, color: 4, signon: { user, passwordEnv: "AS400_PASSWORD" } }
    ],
    sessions: []
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
const page = await browser.newPage({ viewport: { width: 1500, height: 900 } });

/** SQL の要求に載った宛先システムを記録する（**本物の HTTP を覗く**） */
const sqlTargets = [];
page.on("request", (req) => {
  if (!req.url().includes("/api/host/sql")) return;
  try {
    const body = JSON.parse(req.postData() ?? "{}");
    if (body?.source?.system) sqlTargets.push(body.source.system);
  } catch { /* body なしの要求は対象外 */ }
});

const crumb = (label) => page.locator(".crumbs .crumb", { hasText: label });
/**
 * 対象システムを選ぶ。**パンくずの第 1 段は常にある**（未選択なら `システム: —`）ので、
 * ここを入口にすれば「まだ何も選んでいない」状態からも同じ手順で入れる。
 */
async function selectSystem(sysName) {
  const pick = () => page.locator(".card", { hasText: sysName }).first().locator("button", { hasText: "選択" });
  // **既にシステム選択画面に居るなら押さない。** そのときパンくずの第 1 段は
  // `disabled` なので、押そうとすると有効になるまで待ち続ける（実際に踏んだ）
  if ((await pick().count()) === 0) {
    await crumb("システム").first().click();
    await page.waitForSelector(".launcher", { timeout: 10_000 });
  }
  await pick().click();
  await page.waitForSelector(".fn", { timeout: 10_000 });
  await sleep(400);
}
/** 対象システムを選んで機能カードの「開く／表示」を押す */
async function openFeature(sysName, feature) {
  await selectSystem(sysName);
  await page.locator(".fn", { hasText: feature }).first().locator("button").first().click();
  await sleep(700);
}
/**
 * **いま見えている** SQL タブで 1 文実行する。
 *
 * 2 システム分のペインが同時にマウントされている（開いたタブは閉じるまで生きる）ので、
 * `.first()` では**隠れているほう**を掴んで操作できない。受け皿の `data-hidden` で絞る。
 */
const shownPane = () => page.locator(".pane-slot:not([data-hidden])");
async function runSql() {
  await shownPane().locator(".sql-layout textarea").first().fill("SELECT 1 AS N FROM SYSIBM.SYSDUMMY1");
  await shownPane().locator(".sql-layout header button", { hasText: /実行/ }).first().click();
  await sleep(4000);
}
const tabInfo = () =>
  page.evaluate(() =>
    Array.from(document.querySelectorAll(".tabs .tab")).map((el) => ({
      text: el.textContent?.replace(/\s+/g, "") ?? "",
      sysName: el.querySelector(".sysname")?.textContent ?? "",
      bar: el.getAttribute("style") ?? ""
    }))
  );

try {
  await page.goto(`http://127.0.0.1:${PORT}/`);
  await page.waitForSelector(".launcher", { timeout: 15_000 });

  // ---- 1 システムだけのとき ----
  log("### まず A の SQL を開く");
  await openFeature("エー", "SQL");
  await page.waitForSelector(".sql-layout", { timeout: 15_000 });
  let tabs = await tabInfo();
  check(tabs.length === 1, `タブが 1 枚（${tabs.length}）`);
  check(tabs[0]?.sysName === "", "**1 システムだけならシステム名を出さない**（今までの見た目のまま）");
  check(tabs[0]?.bar.includes("--sys-1"), `A の色帯が付く（${tabs[0]?.bar}）`);

  log("\n### A で SQL を実行する");
  await runSql();
  check(await shownPane().innerText().then((t) => t.includes("N")), "A で結果が返る");

  // ---- 2 つ目のシステム ----
  log("\n### B の SQL を開く（別のタブになる）");
  await openFeature("ビー", "SQL");
  await sleep(800);
  tabs = await tabInfo();
  check(tabs.length === 2, `**SQL のタブが 2 枚並ぶ**（${tabs.length}）`);
  check(
    tabs.map((t) => t.sysName).sort().join("/") === "エー/ビー",
    `**2 システム開いたのでシステム名が出る**（${tabs.map((t) => t.sysName).join(" / ")}）`
  );
  check(
    tabs.some((t) => t.bar.includes("--sys-1")) && tabs.some((t) => t.bar.includes("--sys-4")),
    "設定した色がそれぞれのタブに出る"
  );

  log("\n### B で SQL を実行する");
  await runSql();
  check(await shownPane().innerText().then((t) => t.includes("N")), "B で結果が返る");

  // ---- 宛先（本物の HTTP を覗く） ----
  log("\n### 宛先");
  const targets = [...new Set(sqlTargets)].sort();
  check(sqlTargets.length >= 2, `SQL の要求が 2 回以上出ている（${sqlTargets.length}）`);
  check(
    targets.join(",") === [REF_A, REF_B].sort().join(","),
    `**それぞれが自分のシステムへ飛んでいる**（${targets.join(" / ")}）`
  );

  // ---- システムを選び直してもタブは消えない ----
  log("\n### システムを選び直す");
  await selectSystem("エー");
  await crumb("ワークスペース").click();
  await sleep(500);
  tabs = await tabInfo();
  check(tabs.length === 2, `**切り替えてもタブが消えない**（${tabs.length}）`);

  // ---- ヘッダーは常に見ているタブのシステムを映す ----
  log("\n### ヘッダーのシステム表示");
  const headerSystem = async () =>
    (await page.locator(".crumbs .crumb").first().innerText()).replace(/\s+/g, " ");

  // **タブを選び替えるだけで変わる**（メニューを開かない）。以前はここが変わらず、
  // 「A のタブを見ているのにヘッダーは B」という食い違いが起きていた（利用者の指摘）
  await page.locator(".tabs .tab", { hasText: "ビー" }).first().click();
  await sleep(500);
  const onB = await headerSystem();
  check(onB.includes("ビー"), `**B のタブを選ぶとヘッダーが B**（${onB}）`);

  await page.locator(".tabs .tab", { hasText: "エー" }).first().click();
  await sleep(500);
  const onA = await headerSystem();
  check(onA.includes("エー"), `**A のタブを選ぶとヘッダーが A**（${onA}）`);

  // メニューを開いても、そのタブのシステムのまま
  await crumb("メニュー").click();
  await page.waitForSelector(".launcher", { timeout: 10_000 });
  const inMenu = await headerSystem();
  check(inMenu.includes("エー"), `メニューを開いても同じ（${inMenu}）`);

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
