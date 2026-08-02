// **認証を有効にしたときのサービスの見え方・操作可否**を実ブラウザで確かめる
// （`20260801-service-auth-e2e`）。
//
// これまでの実機 E2E は**すべて認証オフ**で走らせていた。そこでは
// `canEditServer` も `assertProfileAccess` も全通過するので、
// **認可が効いているかを一度も測っていない**。
//
// 見るのは 3 つ:
//   1. 一般ユーザーに**一覧は見える**が、**操作ボタンが出ない**
//   2. 一般ユーザーに**失敗の理由が出ない**（文面にサーバーのパスが載りうる）
//   3. **画面が隠しているだけではない**——WS へ直接操作を送っても**サーバーが断る**
//
// 3 が要点。ボタンを消しただけなら、開発者ツールから叩けば通ってしまう。
//
// 実行: node --env-file=.env scripts/verify-service-auth.mjs
//   （事前に `npm run build` と `npm run build -w @ts5250/web-ui` が要る）
//
// 副作用: 既存の仮想プリンター装置を借りる（既定 PRT_TEST）。スプールは流さない。
// **装置は作らない・消さない。** 設定・ユーザーは一時ファイル/メモリで、実機に触らない。
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
  ConfigResolver,
  UserStore,
  SessionStore
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
const PORT = Number(process.env.PORT ?? 3490);
// **この検証専用の使い捨て資格情報。** 実機のものとは無関係で、プロセス内にしか無い
const ADMIN = { name: "svcadmin", pass: "verify-admin-pw" };
const PLAIN = { name: "svcuser", pass: "verify-user-pw" };

const log = (s) => process.stdout.write(s + "\n");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0;
let fail = 0;
const check = (cond, msg) => {
  if (cond) { pass++; log(`  PASS ${msg}`); } else { fail++; log(`  FAIL ${msg}`); }
};

const work = mkdtempSync(join(tmpdir(), "svcauth-"));
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
        autoStart: false,
        printer: { service: true, autoPdfDir: pdfDir }
      }
    ]
  })
);

const users = new UserStore([]);
users.add(ADMIN.name, ADMIN.pass, "admin");
users.add(PLAIN.name, PLAIN.pass, "user");

const crypto = SecretCrypto.fromEnv();
const sessions = new SessionManager();
const resolver = new ConfigResolver(
  ServerConfigStore.fromFile(cfgPath, crypto),
  new PersonalConfigStore({ systems: [], sessions: [] }, crypto)
);
const app = buildApp({
  sessions,
  resolver,
  version: "verify",
  webRoot: "packages/web-ui/dist",
  auth: { enabled: true, users, sessions: new SessionStore() }
});
const wss = new WebSocketServer({ noServer: true });
const server = serve({ fetch: app.fetch, port: PORT, websocket: { server: wss } });
await sleep(600);

const browser = await chromium.launch();
const base = `http://127.0.0.1:${PORT}`;

/** ログインして「サービス」ペインまで開く。**画面のログインフォームを使う**（実際の経路） */
async function openAs(who) {
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } });
  const page = await ctx.newPage();
  await page.goto(`${base}/`);
  await page.waitForSelector("input[placeholder='ユーザー名']", { timeout: 15_000 });
  await page.fill("input[placeholder='ユーザー名']", who.name);
  await page.fill("input[placeholder='パスワード']", who.pass);
  await page.click("button[type=submit]");
  await page.waitForSelector(".launcher", { timeout: 20_000 });
  const pick = page.locator(".card", { hasText: "AS400" }).first().locator("button", { hasText: "選択" });
  if (await pick.count()) { await pick.click(); await sleep(400); }
  await page.locator(".fn.app", { hasText: "サービス" }).locator("button").click();
  await page.waitForSelector(".services", { timeout: 15_000 });
  await sleep(1200);
  return { ctx, page };
}

let adminSide;
let plainSide;
try {
  // ---- 1. admin: 見えて操作できる ----
  log("### 1. 管理者");
  adminSide = await openAs(ADMIN);
  const aRow = adminSide.page.locator(".services tbody tr", { hasText: "PRTSVC" }).first();
  check(await aRow.count() > 0, "サービスが一覧に出る");
  check((await aRow.locator("button").count()) > 0, "**操作ボタンが出る**");
  await aRow.locator("button", { hasText: "開始" }).click();
  const started = await (async () => {
    const t0 = Date.now();
    while (Date.now() - t0 < 40_000) {
      if ((await aRow.innerText()).includes("待ち受け中")) return true;
      await sleep(500);
    }
    return false;
  })();
  check(started, "**管理者は一覧から起動できる**");

  // ---- 2. 一般ユーザー: 見えるが押せない ----
  log("\n### 2. 一般ユーザー");
  plainSide = await openAs(PLAIN);
  const pRow = plainSide.page.locator(".services tbody tr", { hasText: "PRTSVC" }).first();
  check(await pRow.count() > 0, "**サービスは見える**（動いているかが分かる）");
  check((await pRow.innerText()).includes("待ち受け中"), "状態も見える");
  check((await pRow.locator("button").count()) === 0, "**操作ボタンが出ない**");
  const body = await plainSide.page.locator("body").innerText();
  check(body.includes("操作は管理者のみ"), "操作できないことが画面に書いてある");
  check(!body.includes(pdfDir), "**PDF 保存先のパスが出ない**");

  // ---- 3. API を直に叩いても中身は返らない ----
  log("\n### 3. API を直に叩く");
  const api = await plainSide.page.evaluate(async () => ({
    printers: await (await fetch("/api/printers")).json(),
    sessionsCfg: await (await fetch("/api/sessions-config")).json()
  }));
  check(api.printers.editable === false, "`editable: false` が返る");
  check(api.printers.printers.length === 1, "一覧そのものは返る（見るだけは許す）");
  check(api.printers.printers[0].warnings === undefined, "**警告は返らない**");
  check(!JSON.stringify(api.printers).includes(pdfDir), "**パスは返らない**");
  // サーバー設定そのものは従来どおり admin 限定（この PR で緩めていない）
  check(
    api.sessionsCfg.sessions.length === 0,
    `**設定の一覧は 0 件のまま**（実際: ${api.sessionsCfg.sessions.length}）`
  );

  // ---- 4. 画面が隠しているだけではない（WS へ直接送る）----
  //
  // **ここが本番。** ボタンを消しただけなら、開発者ツールから叩けば通ってしまう。
  log("\n### 4. WS へ直接送る（画面を迂回する）");
  const id = api.printers.printers[0].id;
  check(typeof id === "string", "動いている実体の id は一般ユーザーにも見える");
  const wsResult = await plainSide.page.evaluate(
    ([sessionId, ref]) =>
      new Promise((resolve) => {
        const ws = new WebSocket(`ws://${location.host}/ws`);
        const errors = [];
        ws.onopen = () => {
          ws.send(JSON.stringify({ type: "printer-stop", sessionId }));
          ws.send(JSON.stringify({ type: "printer-service-start", session: ref }));
          ws.send(JSON.stringify({ type: "watch-start", session: ref }));
        };
        ws.onmessage = (e) => {
          const m = JSON.parse(e.data);
          if (m.type === "error") errors.push(m.code);
        };
        setTimeout(() => { ws.close(); resolve(errors); }, 2500);
      }),
    [id, "srv:PRTSVC"]
  );
  check(wsResult.length >= 3, `送った 3 通すべてが断られる（実際: ${wsResult.length} 件のエラー / ${wsResult}）`);
  // **止まっていないことをサーバー側で確かめる**——「エラーが返った」だけでは、
  // 止めたうえでエラーを返した可能性を潰せない
  const still = sessions.listPrinters().find((e) => e.ref === "srv:PRTSVC");
  check(still?.state === "listening", `**一般ユーザーは止められない**（実際: ${still?.state}）`);
} catch (e) {
  fail++;
  log(`  FAIL 例外: ${e?.message ?? e}`);
  try {
    const p = plainSide?.page ?? adminSide?.page;
    if (p) log("  --- 画面 ---\n" + (await p.locator("body").innerText()).split("\n").slice(0, 30).map((l) => "  | " + l).join("\n"));
  } catch { /* 良い */ }
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
