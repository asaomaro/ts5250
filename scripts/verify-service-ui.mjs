// **サービスの操作 UI** を実機＋ブラウザで通しで確かめる（`20260801-service-control-ui`）。
//
// 単体テストでは測れないものが 3 つある:
//   1. 設定フォームの往復——**保存で PDF 保存先が消えないか**（消えていたのがこの PR の直し）
//   2. `自動で待ち受け開始 ☐` の定義を開いたとき、画面が**停止中**に見えるか
//   3. 開始ボタンで**本当にホストへ繋がる**か（装置を掴めるか）
//
// 実行: node --env-file=.env scripts/verify-service-ui.mjs
//   （事前に `npm run build` と `npm run build -w @ts5250/web-ui` が要る）
//
// 副作用: 既存の仮想プリンター装置を借り（既定 PRT_TEST）、スプールを 1 件も流さない。
// **装置は作らない・消さない。** 設定は一時ファイルに書き、実機の profiles.json には触らない。
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
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
const PRTDEV = process.env.AS400_PRTDEV ?? "PRT_TEST";
const PORT = Number(process.env.PORT ?? 3488);

const log = (s) => process.stdout.write(s + "\n");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0;
let fail = 0;
const check = (cond, msg) => {
  if (cond) { pass++; log(`  PASS ${msg}`); } else { fail++; log(`  FAIL ${msg}`); }
};

const work = mkdtempSync(join(tmpdir(), "svcui-"));
const pdfDir = join(work, "out");
mkdirSync(pdfDir, { recursive: true }); // 保存時に実在を検査されるので先に作る
const cfgPath = join(work, "profiles.json");
// **パスワードはファイルに書かない**——`passwordEnv` でサーバー設定から環境変数を指す
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
        // **この 2 つがこの PR の主題。** 開いても待ち受けず、サービスとして常駐する
        autoStart: false,
        printer: { service: true, autoPdfDir: pdfDir, pdfFontName: "IPAGothic" }
      }
    ]
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
const text = async () => page.locator("body").innerText();
/** 条件が満たされるまで待つ（実機の接続は数秒かかる） */
async function until(fn, ms = 30_000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (await fn()) return true;
    await sleep(400);
  }
  return false;
}
const hasText = (s) => until(async () => (await text()).includes(s), 30_000);

try {
  await page.goto(`http://127.0.0.1:${PORT}/`);
  await page.waitForSelector(".launcher", { timeout: 15_000 });

  // ---- 1. 設定フォームの往復（保存で消えないか） ----
  log("### 1. 設定フォームの往復");
  // システムが 1 つだと自動で選ばれていることがある。出ているときだけ押す
  const pick = page.locator(".card", { hasText: "AS400" }).first().locator("button", { hasText: "選択" });
  if (await pick.count()) {
    await pick.click();
    await sleep(400);
  }
  const card = () => page.locator(".card", { hasText: "PRTSVC" }).first();
  await card().locator("button", { hasText: "編集" }).click();
  await sleep(300);
  const svcBox = page.locator(".trusted .row", { hasText: "サービスとして使う" }).locator("input[type=checkbox]");
  const pdfInput = page.locator(".trusted .row", { hasText: "PDF 保存先" }).locator("input");
  const autoBox = page.locator(".fgrid .row", { hasText: "自動で待ち受け開始" }).locator("input[type=checkbox]");
  check(await svcBox.isChecked(), "`サービスとして使う` に ✅ が入って開く");
  check((await pdfInput.inputValue()) === pdfDir, `PDF 保存先が読み込まれている（${await pdfInput.inputValue()}）`);
  check((await autoBox.isChecked()) === false, "`自動で待ち受け開始` の ☐ が読み込まれている");

  // 名前だけ直して保存する。**これで PDF 保存先が消えていたのが直す前の挙動**
  const nameInput = page.locator(".fgrid .row", { hasText: "名前" }).locator("input");
  await nameInput.fill("PRTSVC2");
  await page.locator(".editfoot button", { hasText: "保存" }).click();
  await sleep(1200);
  // 保存が黙って失敗していないか（フォームの `.err` に理由が出る）
  const saveErr = page.locator(".card.editing .err");
  check((await saveErr.count()) === 0, `保存が通る${(await saveErr.count()) ? "（" + (await saveErr.innerText()) + "）" : ""}`);
  await page.reload();
  await page.waitForSelector(".launcher", { timeout: 15_000 });
  await sleep(600);
  const card2 = () => page.locator(".card", { hasText: "PRTSVC2" }).first();
  await card2().locator("button", { hasText: "編集" }).click();
  await sleep(400);
  const pdfAfter = await page.locator(".trusted .row", { hasText: "PDF 保存先" }).locator("input").inputValue();
  check(pdfAfter === pdfDir, `**名前を直して保存しても PDF 保存先が残る**（${pdfAfter || "(空)"}）`);
  check(
    await page.locator(".trusted .row", { hasText: "サービスとして使う" }).locator("input[type=checkbox]").isChecked(),
    "サービス ✅ も残る"
  );
  check(
    (await page.locator(".fgrid .row", { hasText: "自動で待ち受け開始" }).locator("input[type=checkbox]").isChecked()) === false,
    "自動で待ち受け開始 ☐ も残る"
  );
  // 編集していないフォント指定（画面に欄が無い項目）が消えていないかを API で見る
  const raw = await page.evaluate(async () => (await (await fetch("/api/sessions-config")).json()));
  const saved = raw.sessions.find((s) => s.name === "PRTSVC2");
  check(saved?.printer?.pdfFontName === "IPAGothic", "**画面に欄が無い項目（pdfFontName）も消えない**");
  await page.locator(".editfoot button", { hasText: "取消" }).click();
  await sleep(300);

  // ---- 2. `自動で待ち受け開始 ☐` で開く ----
  log("\n### 2. 自動で待ち受け開始 ☐ で開く");
  await card2().locator("button", { hasText: /^(接続|開く)$/ }).click();
  await page.waitForSelector(".printer-pane", { timeout: 20_000 });
  await sleep(600);
  check(await hasText("停止中"), "**開いても待ち受けない（停止中と出る）**");
  const startBtn = page.locator(".printer-pane .run-toggle");
  check((await startBtn.innerText()).trim() === "開始", "ボタンが「開始」になっている");
  check(!(await text()).includes("スプール待ち受け中"), "**「待ち受け中…」と嘘を書かない**");

  // ---- 3. 開始（実機の装置を掴む） ----
  log("\n### 3. 開始");
  await startBtn.click();
  check(await hasText("待ち受け中"), "**開始ボタンでホストに繋がる（待ち受け中）**");
  // **「起動:」が出ただけでは足りない。** 待ち受けていなければ `起動: -` になるので、
  // 実際の応答コードまで見ないと「繋がったつもり」を通してしまう
  check(await hasText("起動: I902"), "起動応答コードが I902（＝ホストが装置を受け付けた）");
  check((await startBtn.innerText()).trim() === "停止", "ボタンが「停止」に変わる");

  // ---- 4. 停止 ----
  log("\n### 4. 停止");
  await startBtn.click();
  check(await hasText("停止中"), "**停止ボタンで待ち受けが止まる**");
  check((await startBtn.innerText()).trim() === "開始", "ボタンが「開始」に戻る");

  // ---- 5. 再開（停止で本当に装置を手放していたか） ----
  log("\n### 5. 再開");
  await sleep(3000);
  await startBtn.click();
  check(await hasText("待ち受け中"), "**再開できる（＝停止で本当に装置を手放していた）**");
  await startBtn.click();
  await hasText("停止中");
} catch (e) {
  fail++;
  log(`  FAIL 例外: ${e?.message ?? e}`);
  // **失敗したときは画面の中身を出す。** セレクタが外れたのか、そもそも別の画面なのかが分かれる
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
