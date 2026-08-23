// 実ブラウザ（web-ui）で **PCML ペイン**を実機に対して一通り操作する E2E。
//
// 確かめるのは「**手詰めが要らないこと**」——
//   1. コンパイラが吐いた `.pcml` を IFS の道で読み込む
//   2. 構造体が入れ子で、配列が件数ぶん並ぶ
//   3. 名前で値を入れて呼ぶ
//   4. 結果が**項目の隣**に出る（base64 を目で解かない）
//
// 前提: npm run build && npm run build -w @ts5250/web-ui。
//       scripts/research-pcml.mjs で TESTLIB/PCMLTST と .pcml を作ってあること。
// 実行: node --env-file=.env --env-file=.env.verify scripts/verify-browser-pcml.mjs
import { mkdirSync, rmSync } from "node:fs";
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
const LIB = process.env.AS400_LIB ?? "TESTLIB";

const PORT = 3491;
const PCML_PATH = process.env.PCML_PATH ?? "/home/USER/pcmltst.pcml";
const TMP = "/tmp/as400-verify-pcml";
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
  id: "as400",
  name: (process.env.AS400_SYSTEM ?? "AS400"),
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
  version: "verify-pcml",
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

/** 名前つきの欄に値を入れる */
const put = async (path, value) => page.locator(`[data-kwd="${path}"]`).fill(value);
/** 名前つきの結果を読む */
const got = async (path) => (await page.locator(`[data-out="${path}"]`).textContent())?.trim() ?? "";

try {
  await page.goto(`http://localhost:${PORT}/`);
  // システムが 1 つだけなら選択画面は出ない（自動で選ばれる）
  const picker = page.locator(".card", { hasText: (process.env.AS400_SYSTEM ?? "AS400") }).locator("button", { hasText: "選択" });
  if ((await picker.count()) > 0) await picker.first().click();

  await page.locator(".fn", { hasText: "PCML 呼び出し" }).first().waitFor({ timeout: 30000 });
  await page.locator(".fn", { hasText: "PCML 呼び出し" }).first().locator("button").first().click();
  await page.waitForSelector('[data-testid="pcml-path"]', { timeout: 30000 });
  check("PCML ペインが開く", true);

  // ---- 1. 記述を IFS から読む ----
  await page.locator('[data-testid="pcml-path"]').fill(PCML_PATH);
  await page.locator('[data-testid="pcml-load"]').click();
  await page.locator('[data-kwd="PCMLTST.INTXT"]').waitFor({ timeout: 60000 });
  await shot("01-loaded");

  const chosen = await page.locator('[data-testid="pcml-program"]').inputValue();
  check("記述からプログラムを選べる", chosen === "PCMLTST", chosen);
  check(
    "path から呼び先が読める",
    (await page.locator(".section .note").first().textContent())?.includes(LIB),
    "画面に /QSYS.LIB/TESTLIB.LIB/PCMLTST.PGM が出る"
  );

  // ---- 2. 構造体と配列が展開されている ----
  const kwds = await page.locator("[data-kwd]").evaluateAll((els) => els.map((e) => e.dataset["kwd"]));
  check("**構造体が入れ子で並ぶ**", kwds.includes("PCMLTST.REC.NM"), kwds.filter((k) => k.startsWith("PCMLTST.REC")).join(", "));
  check(
    "**配列が件数ぶん並ぶ（1 始まり）**",
    kwds.includes("PCMLTST.ITEMS(1)") && kwds.includes("PCMLTST.ITEMS(4)") && !kwds.includes("PCMLTST.ITEMS(5)"),
    kwds.filter((k) => k.startsWith("PCMLTST.ITEMS")).join(", ")
  );
  const body = await page.locator(".pane").innerText();
  check("型と長さが添えられる", body.includes("文字 10") && body.includes("詰め 10 進 9.2"), "");
  check("**符号つき整数として出る**", body.includes("整数 8 バイト") && !body.includes("整数 8 バイト・符号なし"), "");

  // ---- 3. 名前で値を入れて呼ぶ（base64 を 1 つも組まない）----
  await put("PCMLTST.INTXT", "HELLO");
  await put("PCMLTST.IONUM", "12.34");
  await put("PCMLTST.REC.ID", "0");
  await put("PCMLTST.REC.RATE", "0");
  await put("PCMLTST.CNT", "0");
  await put("PCMLTST.BIG", "0");
  await put("PCMLTST.AMT", "1.00");
  await shot("02-filled");

  await page.locator('[data-testid="pcml-call"]').click();
  await page.locator('[data-testid="pcml-result"]').waitFor({ timeout: 60000 });
  await shot("03-called");

  const verdict = await page.locator('[data-testid="pcml-result"]').innerText();
  check("呼び出しが成功する", verdict.includes("成功"), verdict.replace(/\s+/gu, " "));
  check("呼び先が返る", verdict.includes("TESTLIB/PCMLTST"), "");

  // ---- 4. 結果が項目の隣に出る ----
  const cases = [
    ["PCMLTST.IONUM", "24.68", "12.34 × 2"],
    ["PCMLTST.REC.ID", "7", "構造体のメンバー"],
    ["PCMLTST.REC.RATE", "1.5000", "構造体のメンバー"],
    ["PCMLTST.CNT", "4", "整数 4 バイト"],
    ["PCMLTST.BIG", "9000000000", "整数 8 バイト"],
    ["PCMLTST.AMT", "2.00", "ゾーン 10 進"]
  ];
  for (const [path, want, why] of cases) {
    const v = await got(path);
    check(`${path} = ${want}（${why}）`, v === want, v);
  }
  check("PCMLTST.REC.NM = REC:HELLO", (await got("PCMLTST.REC.NM")).trim() === "REC:HELLO", await got("PCMLTST.REC.NM"));
  const items = [];
  for (const i of [1, 2, 3, 4]) items.push((await got(`PCMLTST.ITEMS(${i})`)).trim());
  check("PCMLTST.ITEMS(1..4) = AAA,BBB,CCC,DDD", items.join(",") === "AAA,BBB,CCC,DDD", items.join(","));
  check("入力専用は結果を持たない", (await got("PCMLTST.INTXT")) === "", "");

  // ---- 5. 断られ方も見る（足りない入力）----
  await put("PCMLTST.IONUM", "");
  await page.locator('[data-testid="pcml-call"]').click();
  await page.locator('[data-testid="pcml-error"]').waitFor({ timeout: 60000 });
  const err = await page.locator('[data-testid="pcml-error"]').innerText();
  check("**どの項目が悪いか画面に出る**", err.includes("PCMLTST.IONUM"), err.replace(/\s+/gu, " "));
  await shot("04-rejected");
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
