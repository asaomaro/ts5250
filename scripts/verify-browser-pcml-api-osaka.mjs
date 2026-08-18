// 実ブラウザ（web-ui）で **IBM が配っている記述**を貼り付けて実機の API を呼ぶ E2E。
//
// 使うのは `jtopen` 同梱の `qsyrusri.pcml`（Retrieve User Information）。**1 文字も変えていない**。
//
// 確かめるのは:
//   1. IBM の記述を貼り付けて読み込める
//   2. **名前の無い予約域が「（予約）」として出る**（触れないが場所は取る）
//   3. 受取域の長さを入れて呼べる
//   4. 返った値が項目の隣に出る
//   5. 受取域が足りなければ断る
//
// 前提: npm run build && npm run build -w @ts5250/web-ui
// 実行: node --env-file=.env scripts/verify-browser-pcml-api-osaka.mjs
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

const PORT = 3492;
const TMP = "/tmp/as400-verify-pcml-api";
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
  version: "verify-pcml-api",
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
const PCML = readFileSync("packages/hostserver/test/fixtures/pcml/qsyrusri.pcml", "latin1");
const CMDD = readFileSync("packages/hostserver/test/fixtures/pcml/qcdrcmdd.pcml", "latin1");
const USER = (process.env.AS400_USER ?? "").toUpperCase();

try {
  await page.goto(`http://localhost:${PORT}/`);
  const picker = page.locator(".card", { hasText: "SR-OSAKA" }).locator("button", { hasText: "選択" });
  if ((await picker.count()) > 0) await picker.first().click();

  await page.locator(".fn", { hasText: "PCML 呼び出し" }).first().waitFor({ timeout: 30000 });
  await page.locator(".fn", { hasText: "PCML 呼び出し" }).first().locator("button").first().click();
  await page.waitForSelector('[data-testid="pcml-path"]', { timeout: 30000 });

  // ---- 1. IBM の記述をそのまま貼り付ける ----
  await page.locator('input[type="radio"][value="text"]').check();
  await page.locator('[data-testid="pcml-text"]').fill(PCML);
  await page.locator('[data-testid="pcml-load"]').click();
  await page.locator('[data-kwd="qsyrusri.receiverLength"]').waitFor({ timeout: 60000 });
  await shot("01-loaded");

  const chosen = await page.locator('[data-testid="pcml-program"]').inputValue();
  check("IBM の記述を手を入れずに読める", chosen === "qsyrusri", chosen);

  // ---- 2. 予約域 ----
  const text = await page.locator(".pane").innerText();
  check("**名前の無い予約域が画面に出る**", text.includes("（予約）"), "");
  const kwds = await page.locator("[data-kwd]").evaluateAll((els) => els.map((e) => e.dataset["kwd"]));
  check(
    "**予約域には入力欄が無い**（名前で触れない）",
    kwds.every((k) => k !== "" && k !== undefined),
    kwds.join(", ")
  );
  check(
    "受取域の中は出力なので入力欄が出ない",
    !kwds.includes("qsyrusri.receiver.userProfile"),
    ""
  );
  check(
    "`init` のある入力は既定値が入っている",
    (await page.locator('[data-kwd="qsyrusri.format"]').inputValue()) === "USRI0100",
    ""
  );

  // ---- 3. 呼ぶ ----
  await page.locator('[data-kwd="qsyrusri.receiverLength"]').fill("83");
  await page.locator('[data-testid="pcml-call"]').click();
  await page.locator('[data-testid="pcml-result"]').waitFor({ timeout: 60000 });
  await shot("02-called");

  const verdict = await page.locator('[data-testid="pcml-result"]').innerText();
  check("呼び出しが成功する", verdict.includes("成功"), verdict.replace(/\s+/gu, " "));
  check("小文字の path から呼び先を解く", verdict.includes("QSYS/QSYRUSRI"), "");

  // ---- 4. 返った値 ----
  for (const [path, want] of [
    ["qsyrusri.receiver.bytesReturned", "83"],
    ["qsyrusri.receiver.userProfile", USER],
    ["qsyrusri.receiver.status", "*ENABLED"]
  ]) {
    const v = await got(path);
    check(`${path} = ${want}`, v.trim() === want, v.trim());
  }

  // ---- 5. `outputsize` を持つ記述（QCDRCMDD）----
  // `qsyrusri.pcml` に `outputsize` は無い。受取域の大きさを別に決める形は
  // `qcdrcmdd.pcml` が使っている（`outputsize="length"`）
  await page.locator('[data-testid="pcml-text"]').fill(CMDD);
  await page.locator('[data-testid="pcml-load"]').click();
  await page.locator('[data-kwd="qcdrcmdd.length"]').waitFor({ timeout: 60000 });
  check(
    "**`outputsize` を持つ記述も読める**",
    (await page.locator('[data-testid="pcml-program"]').inputValue()) === "qcdrcmdd",
    ""
  );
  check(
    "受取域の長さの既定値が入っている",
    (await page.locator('[data-kwd="qcdrcmdd.length"]').inputValue()) === "49152",
    ""
  );
  await shot("03-cmdd");

  // 受取域を記述が要る大きさより小さくすると断られる
  await page.locator('[data-kwd="qcdrcmdd.length"]').fill("4");
  await page.locator('[data-testid="pcml-call"]').click();
  await page.locator('[data-testid="pcml-error"]').waitFor({ timeout: 60000 });
  const err = await page.locator('[data-testid="pcml-error"]').innerText();
  check("**受取域が足りなければ断る**（返るバイトが黙って切れる）", err.includes("小さい"), err.replace(/\s+/gu, " "));
  await shot("04-too-small");
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
