// 実ブラウザ（web-ui）で **飛び先つきの記述**（IBM の RUser.pcml）を呼ぶ E2E。
//
// `USRI0300` は、飛び先・出力で決まる件数と長さと CCSID が 1 つの書式に全部入っている。
//
// 確かめるのは:
//   1. 件数が出力で決まる行は「**呼ぶまで分かりません**」と出る
//   2. 呼ぶと**飛び先の先**（ホームディレクトリ）が読める
//   3. その値が実体（/home/…）と一致する
//
// 前提: npm run build && npm run build -w @ts5250/web-ui
// 実行: node --env-file=.env scripts/verify-browser-pcml-dynamic-osaka.mjs
import { readFileSync, mkdirSync, rmSync } from "node:fs";
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

const PORT = 3493;
const TMP = "/tmp/as400-verify-pcml-dynamic";
const SHOTS = `${TMP}/shots`;
rmSync(TMP, { recursive: true, force: true });
mkdirSync(SHOTS, { recursive: true });

const log = (s) => process.stderr.write(`${s}\n`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok, detail });
  process.stdout.write(`${ok ? "OK  " : "NG  "} ${name}${detail ? ` — ${detail}` : ""}\n`);
};

// **接続はその場で組む**（`connections.json` に依存しない）。
// パスワードは `passwordEnv` で環境変数を指す——**スクリプトにも設定にも書かない**
const host = process.env.AS400_HOST;
const user = process.env.AS400_USER;
if (!host || !user) throw new Error("AS400_HOST / AS400_USER が要ります");
const sys = {
  id: "osaka",
  name: "SR-OSAKA",
  host,
  signon: { user, passwordEnv: "AS400_PASSWORD" }
};
const resolver = new ConfigResolver(
  new ServerConfigStore({ systems: [], sessions: [] }),
  new PersonalConfigStore({ systems: [sys], sessions: [] })
);
const app = buildApp({
  sessions: new SessionManager(),
  resolver,
  version: "verify-pcml-dynamic",
  webRoot: "packages/web-ui/dist"
});
const wss = new WebSocketServer({ noServer: true });
const http = serve({ fetch: app.fetch, port: PORT, websocket: { server: wss } });
await sleep(600);

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
page.on("pageerror", (e) => log(`PAGEERR ${e.message}`));
page.on("console", (m) => {
  if (m.type() === "error") log(`[console] ${m.text()}`);
});
const shot = async (name) => page.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: true });

/** 名前つきの結果を読む */
const got = async (path) => (await page.locator(`[data-out="${path}"]`).textContent())?.trim() ?? "";

/** IBM の原本（`jtopen` 同梱）。手を入れない */
const PCML = readFileSync("packages/hostserver/test/fixtures/pcml/RUser.pcml", "latin1");
const USER = (process.env.AS400_USER ?? "").toUpperCase();
const R = "qsyrusri_usri0300.receiverVariable";

try {
  await page.goto(`http://localhost:${PORT}/`);
  const picker = page.locator(".card", { hasText: "SR-OSAKA" }).locator("button", { hasText: "選択" });
  if ((await picker.count()) > 0) await picker.first().click();

  await page.locator(".fn", { hasText: "PCML 呼び出し" }).first().waitFor({ timeout: 30000 });
  await page.locator(".fn", { hasText: "PCML 呼び出し" }).first().locator("button").first().click();
  await page.waitForSelector('[data-testid="pcml-path"]', { timeout: 30000 });

  // ---- 1. 飛び先つきの記述を貼り付け、USRI0300 を選ぶ ----
  await page.locator('input[type="radio"][value="text"]').check();
  await page.locator('[data-testid="pcml-text"]').fill(PCML);
  await page.locator('[data-testid="pcml-load"]').click();
  await page.locator('[data-testid="pcml-program"]').waitFor({ timeout: 60000 });
  await page.locator('[data-testid="pcml-program"]').selectOption("qsyrusri_usri0300");
  await page.locator(`[data-kwd="qsyrusri_usri0300.userProfileName"]`).waitFor({ timeout: 30000 });
  await shot("01-loaded");

  const before = await page.locator(".pane").innerText();
  check("**件数が出力で決まる行は「呼ぶまで分かりません」**", before.includes("呼ぶまで分かりません"),
    "supplementalGroups の件数は numberOfSupplementalGroups で決まる");
  check("しおり（長さ 0 の名前なし項目）は（予約）として出る", before.includes("（予約）"), "");

  // ---- 2. 呼ぶ ----
  await page.locator(`[data-kwd="qsyrusri_usri0300.userProfileName"]`).fill("*CURRENT");
  await page.locator('[data-testid="pcml-call"]').click();
  await page.locator('[data-testid="pcml-result"]').waitFor({ timeout: 60000 });
  await shot("02-called");

  const verdict = await page.locator('[data-testid="pcml-result"]').innerText();
  check("呼び出しが成功する", verdict.includes("成功"), verdict.replace(/\s+/gu, " "));

  // ---- 3. 飛び先の先が読める ----
  const home = (await got(`${R}.homeDirectory.homeDirectoryNameValue`)).trim();
  check("**飛び先の先（ホームディレクトリ）が読める**", home.length > 0, home);
  check("値が実体と合う", home.toUpperCase().includes(USER), `${home} に ${USER} が含まれる`);

  const ccsid = (await got(`${R}.homeDirectory.ccsidOfTheReturnedHomeDirectoryName`)).trim();
  check("**出力で決まる CCSID がそのまま見える**", ccsid === "1200", `CCSID=${ccsid}（UTF-16）`);

  const offset = (await got(`${R}.offsetToHomeDirectory`)).trim();
  check("飛び先の値も読める", Number(offset) > 0, `offsetToHomeDirectory=${offset}`);

  const locale = (await got(`${R}.localePathName`)).trim();
  check("**出力で決まる長さ**（ロケール名）が読める", locale.length > 0, locale);
} catch (e) {
  check("スクリプトが最後まで走る", false, String(e?.stack ?? e));
  await shot("99-crash");
} finally {
  await browser.close();
  http.close();
  wss.close();
}

const failed = results.filter((r) => !r.ok);
process.stdout.write(`\n${results.length - failed.length}/${results.length} 成功（画像: ${SHOTS}）\n`);
process.exit(failed.length > 0 ? 1 : 0);
