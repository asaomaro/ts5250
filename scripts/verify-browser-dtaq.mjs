// 実ブラウザでのデータ待ち行列パネル E2E。build 済み web-ui を server で配信し、Playwright で:
//   1) ランチャーから「データ待ち行列」を開く
//   2) キューを作成（FIFO・送信者情報あり）
//   3) 送信 → ピークで中身が表示される（消費しない）
//   4) 属性が表示される（FIFO / 送信者情報あり）
//   5) 一覧（SQL 経由）に hex 付きで出る
//   6) クリア → 一覧が空になる
//   7) 削除 → 削除後の属性取得が NOT_FOUND（日本語文言）
//
// **フィクスチャ（キュー）は E2E が自分で作って片付ける**（実機の残置に依存しない）。
// 前提: npm run build 済み。実機の TESTLIB ライブラリに書ける資格情報（profiles.local.json / .env）。
// 実行: node --env-file=.env --env-file=.env.verify scripts/verify-browser-dtaq.mjs
import { serve } from "@hono/node-server";
import { WebSocketServer } from "ws";
import {
  buildApp,
  SessionManager,
  ServerConfigStore,
  PersonalConfigStore,
  ConfigResolver,
  migrateProfiles
} from "@ts5250/server";
import { SecretCrypto } from "../packages/server/dist/secret-crypto.js";
import { chromium } from "playwright";
import { readFileSync } from "node:fs";

const LIB = process.env.AS400_LIB ?? "TESTLIB";
const NAME = "DTAQB2E"; // browser e2e 用
const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok, detail });
  process.stdout.write(`${ok ? "OK  " : "NG  "} ${name}${detail ? ` — ${detail}` : ""}\n`);
};

async function main() {
  const raw = JSON.parse(readFileSync("profiles.local.json", "utf8"));
  const crypto = SecretCrypto.fromEnv();
  const { systems, sessions } = migrateProfiles(raw.profiles);
  const resolver = new ConfigResolver(
    new ServerConfigStore({ systems, sessions }, crypto),
    new PersonalConfigStore({ systems: [], sessions: [] }, crypto)
  );
  const app = buildApp({
    sessions: new SessionManager(),
    resolver,
    version: "e2e",
    webRoot: "packages/web-ui/dist"
  });
  const port = 3432;
  const wss = new WebSocketServer({ noServer: true });
  const http = serve({ fetch: app.fetch, port, websocket: { server: wss } });

  const source = { system: "srv:pub400.com" };
  const api = async (route, body) => {
    const res = await fetch(`http://localhost:${port}/api/host/dtaq/${route}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ source, library: LIB, name: NAME, ...body })
    });
    return { status: res.status, body: await res.json().catch(() => ({})) };
  };

  // 前回の残りがあれば消す
  await api("delete", {});

  const browser = await chromium.launch();
  const page = await browser.newPage();
  page.on("console", (m) => {
    if (m.type() === "error") process.stdout.write(`  [console] ${m.text()}\n`);
  });

  try {
    await page.goto(`http://localhost:${port}/`);
    // システムは server 設定から自動選択される（"… のセッション" が出る）。機能カードを待つ
    await page.locator(".fn .nm", { hasText: "データ待ち行列" }).first().waitFor({ timeout: 20000 });
    // 1) 「データ待ち行列」カードの「開く」を押す
    const card = page.locator(".fn").filter({ has: page.locator(".nm", { hasText: "データ待ち行列" }) }).first();
    await card.locator("button", { hasText: /開く|表示/ }).click();
    await page.waitForSelector(".dtaq", { timeout: 20000 });
    check("パネルが開く", true);

    // キューを指定
    const inputs = page.locator(".head input");
    await inputs.nth(0).fill(LIB);
    await inputs.nth(1).fill(NAME);

    // 2) 作成（送信者情報のチェックを入れてから）
    await page.locator('fieldset:has(legend:text("管理")) input[type="checkbox"]').check();
    await page.locator("button", { hasText: "作成" }).click();
    await page.locator("p.note", { hasText: "作成しました" }).waitFor({ timeout: 30000 });
    check("キューを作成できる", true);

    // 3) 送信 → ピーク
    await page.locator(".dtaq textarea").fill("hello-e2e");
    await page.locator("button", { hasText: "送信" }).click();
    await page.locator("p.note", { hasText: "送信しました" }).waitFor({ timeout: 30000 });
    await page.locator("button", { hasText: "ピーク" }).click();
    await page.locator(".result", { hasText: "hello-e2e" }).waitFor({ timeout: 30000 });
    const result = (await page.locator(".result").textContent()) ?? "";
    check("ピークで中身が出る（送信者情報つき）", result.includes("hello-e2e") && /QUSER|QZHQSSRV|USER/.test(result), result.trim());

    // 4) 属性
    await page.locator(".head button", { hasText: "属性" }).click();
    await page.locator(".attrs").waitFor({ timeout: 30000 });
    const attrs = (await page.locator(".attrs").textContent()) ?? "";
    check("属性が表示される（FIFO・送信者情報あり）", attrs.includes("FIFO") && attrs.includes("あり"), attrs.trim());

    // 5) 一覧（SQL 経由）
    await page.locator(".head button", { hasText: "一覧" }).click();
    await page.locator(".list table tbody tr").first().waitFor({ timeout: 30000 });
    const rowText = (await page.locator(".list table tbody tr").first().textContent()) ?? "";
    // hex 68656C6C6F2D653265 = "hello-e2e"
    check("一覧に hex 付きで出る", rowText.includes("68656C6C6F"), rowText.replace(/\s+/g, " ").trim());

    // 6) クリア → 一覧が空
    await page.locator("button", { hasText: "クリア" }).click();
    await page.locator("p.note", { hasText: "クリアしました" }).waitFor({ timeout: 30000 });
    await page.locator(".list td.empty").waitFor({ timeout: 30000 }).catch(() => {});
    const emptyShown = (await page.locator(".list td.empty").count()) === 1;
    check("クリア後は一覧が空になる", emptyShown);

    // 7) 削除 → 削除後の属性取得が NOT_FOUND（日本語）
    await page.locator("button", { hasText: "削除" }).click();
    await page.locator("p.note", { hasText: "削除しました" }).waitFor({ timeout: 30000 });
    // 削除済みキューを直接叩いて NOT_FOUND を確認（UI は attrs をクリア済みなので API で見る）
    const gone = await api("attributes", {});
    check("削除後の属性取得は 404 NOT_FOUND", gone.status === 404 && gone.body.code === "NOT_FOUND", `status=${gone.status} code=${gone.body.code}`);
  } finally {
    await api("delete", {}); // 念のため片付け
    await browser.close();
    http.close();
    wss.close();
  }

  const failed = results.filter((r) => !r.ok);
  process.stdout.write(`\n${results.length - failed.length}/${results.length} 成功\n`);
  process.exit(failed.length > 0 ? 1 : 0);
}

main().catch((e) => {
  process.stderr.write(`${e?.stack ?? e}\n`);
  process.exit(1);
});
