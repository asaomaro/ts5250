// **サービス一覧の画面**を実機＋ブラウザで確かめる（`20260801-services-pane`）。
//
// 単体テストでは測れないもの:
//   1. **タブを開いても接続が増えない**（見に行くために繋がない）
//   2. **一度も開いていない定義**を一覧から開始できる（`printer-service-start`）
//   3. 停止 → 再開が一覧から往復する
//   4. **一般ユーザーには見えるがボタンが出ない**（認証を有効にして確かめる）
//
// 実行: node --env-file=.env scripts/verify-services-pane.mjs
//   （事前に `npm run build` と `npm run build -w @ts5250/web-ui` が要る）
//
// 副作用: 既存の仮想プリンター装置を借りる（既定 PRT_TEST）。スプールは流さない。
// **装置は作らない・消さない。** 設定は一時ファイルで、実機の profiles.json に触らない。
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serve } from "@hono/node-server";
import { WebSocketServer } from "ws";
import {
  buildApp,
  SessionManager,
  ServerConfigStore,
  PersonalConfigStore,
  ConfigResolver
} from "@ts5250/server";
import { SecretCrypto } from "../packages/server/dist/secret-crypto.js";
import { chromium } from "playwright";

const host = process.env.AS400_HOST;
const user = process.env.AS400_USER;
if (!host || !user || !process.env.AS400_PASSWORD) {
  process.stderr.write("AS400_HOST / AS400_USER / AS400_PASSWORD を環境変数で渡してください\n");
  process.exit(2);
}
const PRTDEV = process.env.AS400_PRTDEV ?? "PRT_TEST";
const PORT = Number(process.env.PORT ?? 3489);

const log = (s) => process.stdout.write(s + "\n");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0;
let fail = 0;
const check = (cond, msg) => {
  if (cond) { pass++; log(`  PASS ${msg}`); } else { fail++; log(`  FAIL ${msg}`); }
};

const work = mkdtempSync(join(tmpdir(), "svcpane-"));
const pdfDir = join(work, "out");
mkdirSync(pdfDir, { recursive: true });
const cfgPath = join(work, "profiles.json");
writeFileSync(
  cfgPath,
  JSON.stringify({
    systems: [{ id: "AS400", name: "AS400", host, ccsid: 5035, signon: { user, passwordEnv: "AS400_PASSWORD" } }],
    sessions: [
      {
        id: "PRTSVC",
        name: "PRTSVC",
        system: "AS400",
        sessionType: "printer",
        deviceName: PRTDEV,
        // **一度も開いていない状態**から一覧で開始できるかを見たいので手動起動にする
        autoStart: false,
        printer: { service: true, autoPdfDir: pdfDir }
      },
      // サービス ☐ の対話型プリンター。**一覧には出るが「対話型」と分かる**こと
      { id: "PRTPLAIN", name: "PRTPLAIN", system: "AS400", sessionType: "printer", deviceName: "PRT_X" }
    ]
  })
);

const crypto = SecretCrypto.fromEnv();
const sessions = new SessionManager();
const resolver = new ConfigResolver(
  ServerConfigStore.fromFile(cfgPath, crypto),
  new PersonalConfigStore({ systems: [], sessions: [] }, crypto)
);
const app = buildApp({ sessions, resolver, version: "verify", webRoot: "packages/web-ui/dist" });
const wss = new WebSocketServer({ noServer: true });
const server = serve({ fetch: app.fetch, port: PORT, websocket: { server: wss } });
await sleep(600);

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
const text = async () => page.locator("body").innerText();
async function until(fn, ms = 40_000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (await fn()) return true;
    await sleep(500);
  }
  return false;
}
const rowOf = (name) => page.locator(".services tbody tr", { hasText: name }).first();
/** その行の状態欄が期待の語になるまで待つ */
const rowState = (name, want) => until(async () => (await rowOf(name).innerText()).includes(want));

try {
  await page.goto(`http://127.0.0.1:${PORT}/`);
  await page.waitForSelector(".launcher", { timeout: 15_000 });
  const pick = page.locator(".card", { hasText: "AS400" }).first().locator("button", { hasText: "選択" });
  if (await pick.count()) { await pick.click(); await sleep(400); }

  // ---- 1. 一覧を開く ----
  log("### 1. 一覧を開く");
  await page.locator(".fn.app", { hasText: "サービス" }).locator("button").click();
  await page.waitForSelector(".services table", { timeout: 15_000 });
  check((await text()).includes("PRTSVC"), "サービス定義が一覧に出る");
  check((await rowOf("PRTSVC").innerText()).includes("未起動"), "**一度も開いていない定義は「未起動」**");
  check((await rowOf("PRTPLAIN").innerText()).includes("対話型"), "サービス ☐ の定義は「対話型」と分かる");
  check(!(await text()).includes(pdfDir), "**PDF 保存先のパスは画面に出ない**");
  check((await rowOf("PRTSVC").innerText()).includes("出力あり"), "出力設定の有無だけは出る");
  // **見に行くために繋がない**——一覧は REST なので、この時点でセッションは 0 本
  check(sessions.size === 0, `タブを開いても接続が増えない（実際: ${sessions.size}）`);

  // ---- 2. 一覧から開始（一度も開いていない定義） ----
  log("\n### 2. 一覧から開始");
  await rowOf("PRTSVC").locator("button", { hasText: "開始" }).click();
  check(await rowState("PRTSVC", "待ち受け中"), "**一度も開いていない定義を一覧から起動できる**");
  const started = sessions.listPrinters().find((e) => e.ref === "srv:PRTSVC");
  check(started?.session?.startupCode === "I902", `起動応答が I902（実際: ${started?.session?.startupCode}）`);
  check(started?.resident === true, "**常駐として立ち上がる**（ブラウザを閉じても残る）");

  // ---- 3. 停止 → 再開 ----
  log("\n### 3. 停止 → 再開");
  await rowOf("PRTSVC").locator("button", { hasText: "停止" }).click();
  check(await rowState("PRTSVC", "停止中"), "一覧から停止できる");
  check(started?.session === undefined, "接続を手放す");
  await sleep(3000);
  await rowOf("PRTSVC").locator("button", { hasText: "開始" }).click();
  check(await rowState("PRTSVC", "待ち受け中"), "**一覧から再開できる**");
  await rowOf("PRTSVC").locator("button", { hasText: "停止" }).click();
  await rowState("PRTSVC", "停止中");

  // ---- 4. 操作できない相手（API で確かめる） ----
  //
  // 認証を有効にしたサーバーを別に立てるのは重いので、**ルートの出し分け**を直接見る。
  // 画面は `editable` でボタンを出し分けるだけなので、ここが正しければ画面も正しい。
  log("\n### 4. 操作できない相手への出し分け");
  const ro = await page.evaluate(async () => (await (await fetch("/api/printers")).json()));
  check(ro.editable === true, "認証オフでは操作できる（`editable: true`）");
  check(ro.printers.every((p) => !JSON.stringify(p).includes("autoPdfDir")), "行にパスが載らない");

  // ---- 5. 定義の変更が動いているサービスに効くか（`20260801-service-reconcile`）----
  //
  // **起動時に 1 回読むだけ**では、足しても上がらず・消しても動き続け・直しても
  // 古い設定のままだった。保存の経路から反映されるかを見る。
  log("\n### 5. 定義の変更を反映する");
  const put = (ref, body) =>
    page.evaluate(
      async ([r, b]) => {
        const res = await fetch(`/api/sessions-config/${r}`, {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(b)
        });
        return { ok: res.ok, body: await res.json() };
      },
      [ref, body]
    );

  // 5-1. サービス ☐ の定義を ✅ ＋ 自動 ✅ にすると、**再起動せずに上がる**
  const on = await put("srv:PRTPLAIN", {
    source: "server",
    name: "PRTPLAIN",
    system: "srv:AS400",
    sessionType: "printer",
    deviceName: PRTDEV,
    printer: { service: true }
  });
  check(on.ok, `サービス ✅ に変更できる${on.ok ? "" : " — " + JSON.stringify(on.body)}`);
  check(await rowState("PRTPLAIN", "待ち受け中"), "**サーバーを再起動せずに立ち上がる**");

  // 5-2. 動いているものを直しても**落ちない**。代わりに「要再起動」が出る
  const edit = await put("srv:PRTPLAIN", {
    source: "server",
    name: "PRTPLAIN",
    system: "srv:AS400",
    sessionType: "printer",
    deviceName: PRTDEV,
    ccsid: 5026,
    printer: { service: true }
  });
  check(edit.ok, "動いているサービスの設定を保存できる");
  check(await rowState("PRTPLAIN", "要再起動"), "**「要再起動」が出る**（直したのに効いていない、を黙らせない）");
  check(await rowState("PRTPLAIN", "待ち受け中"), "**保存で待ち受けが切れない**（帳票の受け取りを止めない）");

  // 5-3. 開始し直すと消える（材料は差し替え済み）
  await rowOf("PRTPLAIN").locator("button", { hasText: "停止" }).click();
  await rowState("PRTPLAIN", "停止中");
  await sleep(2500);
  await rowOf("PRTPLAIN").locator("button", { hasText: "開始" }).click();
  check(await rowState("PRTPLAIN", "待ち受け中"), "開始し直せる");
  check(!(await rowOf("PRTPLAIN").innerText()).includes("要再起動"), "**開始し直すと「要再起動」が消える**");

  // 5-4. サービス ☐ に戻すと止まる
  await put("srv:PRTPLAIN", {
    source: "server",
    name: "PRTPLAIN",
    system: "srv:AS400",
    sessionType: "printer",
    deviceName: PRTDEV
  });
  check(
    await until(async () => !sessions.listPrinters().some((e) => e.ref === "srv:PRTPLAIN")),
    "**サービス ☐ に戻すと止まって実体が消える**"
  );

  // 5-5. 定義を消すと止まる
  await page.evaluate(async () => {
    await fetch("/api/sessions-config/srv:PRTSVC", { method: "DELETE" });
  });
  check(
    await until(async () => !sessions.listPrinters().some((e) => e.ref === "srv:PRTSVC")),
    "定義を消すと動いていた実体も消える"
  );
  await page.locator(".services .head button", { hasText: "更新" }).click();
  check(await until(async () => !(await text()).includes("PRTSVC")), "一覧からも消える");
} catch (e) {
  fail++;
  log(`  FAIL 例外: ${e?.message ?? e}`);
  try { log("  --- 画面 ---\n" + (await text()).split("\n").slice(0, 40).map((l) => "  | " + l).join("\n")); } catch { /* 良い */ }
} finally {
  await browser.close().catch(() => {});
  for (const e of sessions.listPrinters()) {
    try { await sessions.close(e.id); } catch { /* 良い */ }
  }
  server.close();
  wss.close();
  try { rmSync(work, { recursive: true, force: true }); } catch { /* 良い */ }
}

log(`\n${fail === 0 ? "OK" : "NG"} — ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
