// 実ブラウザ（web-ui）で実機のデータ待ち行列を**常駐監視**できるか検証する。
//
//   監視を開始 → 別接続からエントリを送る → **画面操作なしで履歴に現れる**
//   → タブを離しているときに送ると**タブに未読が付く** → 停止できる
//   → **タブを閉じても監視は止まらない**（開き直すと閉じていた間の到着が履歴にある）
//
// **「画面に触れなくても気づける」はここでしか確かめられない。** 単体テストは
// store とレジストリを別々に見ているだけで、ホストから届いたものが
// WS を通ってタブのバッジになるまでの通り道は実物に聞くほかない。
//
// 前提: npm run build 済み。`connections.json` に実機。
// 実行: AS400_PASSWORD=... node scripts/verify-browser-watch.mjs
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { serve } from "@hono/node-server";
import { WebSocketServer } from "ws";
import {
  buildApp,
  SessionManager,
  ServerConfigStore,
  PersonalConfigStore,
  ConfigResolver,
  WatchRegistry
} from "@as400web/server";
import { DtaqConnection } from "@as400web/core";
import { SecretCrypto } from "../packages/server/dist/secret-crypto.js";
import { chromium } from "playwright";

const log = (s) => process.stderr.write(s + "\n");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const PORT = 3485;
const TMP = process.env.WATCH_TMP ?? "/tmp/as400-verify-watch";
const SHOTS = `${TMP}/shots`;
mkdirSync(SHOTS, { recursive: true });

const LIB = "TESTLIB";
const QUEUE = "DTQWATCH";
const results = [];
const check = (n, ok, d = "") => {
  results.push({ n, ok });
  process.stdout.write(`${ok ? "OK  " : "NG  "} ${n}${d ? ` — ${d}` : ""}\n`);
};

const cfg = JSON.parse(readFileSync("connections.json", "utf8"));
const sys = cfg.systems.find((s) => s.name === "実機");
const password = process.env.AS400_PASSWORD;
if (!password) {
  log("AS400_PASSWORD が未設定です");
  process.exit(1);
}
// **資格情報は `passwordEnv` で渡す。** この環境では `SecretCrypto.fromEnv()` が
// 使えず `passwordEnc` を復号できないため、解決器が「ユーザーとパスワードが登録されていない」で
// 断る（実際に踏んだ）。`passwordEnv` は運用者向けの正規の経路なので、その道で確かめる。
// **書くのは環境変数の名前だけ**——値はファイルに落とさない（AGENTS.md セキュリティ）。
const target = cfg.systems.find((s) => s.name === "実機");
target.signon = { user: target.signon.user, passwordEnv: "AS400_PASSWORD" };

// **監視の設定を足す。** 監視は保存済み設定からしか始められない（設計）
cfg.sessions.push({
  id: "watch-e2e",
  name: "E2E 監視",
  system: sys.id,
  sessionType: "dtaqwatch",
  dtaqWatch: { library: LIB, name: QUEUE, encoding: "utf8" }
});
mkdirSync(TMP, { recursive: true });
const tmpCfg = `${TMP}/conn-watch.json`;
writeFileSync(tmpCfg, JSON.stringify(cfg));

/** 別接続からエントリを送る（監視中の接続は待機中で使えない） */
async function sendEntry(text) {
  const c = await DtaqConnection.connect({
    host: sys.host,
    user: sys.signon.user,
    password,
    ...(sys.tls !== undefined ? { tls: sys.tls } : {})
  });
  try {
    await c.write(QUEUE, LIB, new TextEncoder().encode(text));
  } finally {
    c.close();
  }
}

const crypto = SecretCrypto.fromEnv();
const watches = new WatchRegistry();
const resolver = new ConfigResolver(
  ServerConfigStore.fromFile(tmpCfg, crypto),
  new PersonalConfigStore({ systems: [], sessions: [] }, crypto)
);
const app = buildApp({
  sessions: new SessionManager(),
  resolver,
  watches,
  version: "verify",
  webRoot: "packages/web-ui/dist"
});
const wss = new WebSocketServer({ noServer: true });
const server = serve({ fetch: app.fetch, port: PORT, websocket: { server: wss } });
await sleep(600);

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1500, height: 900 } });
page.on("pageerror", (e) => log("PAGEERR " + e.message));
const bodyText = () => page.locator("body").innerText();
const shot = async (name) => {
  await page.screenshot({ path: `${SHOTS}/${name}.png` });
  log(`shot: ${SHOTS}/${name}.png`);
};

try {
  // キューを作り直す（前回の残りを消す）
  const setup = await DtaqConnection.connect({
    host: sys.host,
    user: sys.signon.user,
    password,
    ...(sys.tls !== undefined ? { tls: sys.tls } : {})
  });
  await setup.deleteQueue(QUEUE, LIB).catch(() => undefined);
  await setup.create({ name: QUEUE, library: LIB, maxEntryLength: 100, type: "FIFO" });
  setup.close();
  log(`${LIB}/${QUEUE} を作成`);

  await page.goto(`http://localhost:${PORT}/`);
  await page.waitForSelector(".launcher", { timeout: 20000 });
  await page.click(".card:has-text('実機') >> button:has-text('選択')");
  await page.waitForSelector(".card:has-text('E2E 監視')", { timeout: 10000 });
  await shot("01-launcher");

  // --- 監視を開始 ---
  await page.click(".card:has-text('E2E 監視') >> button:has-text('接続')");
  await page.waitForSelector(".watch", { timeout: 15000 });
  await sleep(1500);
  const started = (await bodyText()).includes(`${LIB}/${QUEUE}`);
  check("監視が始まり、一覧にキューが出る", started, (await bodyText()).slice(0, 120));
  check("消費する注意が出ている", (await bodyText()).includes("取り出して消します"));
  await shot("02-watching");

  // --- 画面操作なしで履歴に現れる ---
  await sendEntry("ORD-0001");
  await page.waitForFunction(() => document.body.innerText.includes("ORD-0001"), { timeout: 15000 });
  check("**画面操作なしで履歴に現れる**", true);
  await shot("03-entry");

  // --- タブを離しているときの未読 ---
  // 別タブ（データ待ち行列）を開いて監視タブから離れる。
  // **パンくずは `button.crumb`**（`text=メニュー` は他の文字列にも当たって落ちた）
  await page.click('button.crumb:has-text("メニュー")');
  await page.waitForSelector(".launcher", { timeout: 10000 });
  // 機能カードは `.fn`（セッション設定の `.card` とは別のクラス）
  await page.click(".fn:has-text('データ待ち行列') >> button");
  await sleep(1200);
  await sendEntry("ORD-0002");
  await sleep(2500);
  const badge = await page.locator(".tab .badge").first();
  const hasBadge = (await badge.count()) > 0;
  check("**タブを離れているときに届くと未読が付く**", hasBadge, hasBadge ? await badge.innerText() : "バッジなし");
  await shot("04-unread");

  // --- タブを開くと未読が消える ---
  if (hasBadge) {
    await page.click(".tab:has-text('待ち行列監視')");
    await sleep(1200);
    const still = await page.locator(".tab:has-text('待ち行列監視') .badge").count();
    check("タブを開くと未読が消える", still === 0);
    check("離れている間の到着も履歴にある", (await bodyText()).includes("ORD-0002"));
  }

  // --- タブを閉じても監視は止まらない ---
  await page.click(".tab:has-text('待ち行列監視') >> button.x");
  await sleep(1000);
  check("タブを閉じてもサーバー側の監視は残っている", watches.list().length === 1, `watches=${watches.list().length}`);
  await sendEntry("ORD-0003");
  await sleep(2500);
  // **ページを読み込み直す＝ブラウザを閉じて開き直すのと同じ**。
  // 監視はサーバーのレジストリが持っているので、これで消えてはいけない
  await page.goto(`http://localhost:${PORT}/`);
  await page.waitForSelector(".launcher", { timeout: 20000 });
  await page.click(".card:has-text('実機') >> button:has-text('選択')");
  await page.waitForSelector(".card:has-text('E2E 監視')", { timeout: 10000 });
  await page.click(".card:has-text('E2E 監視') >> button:has-text('接続')");
  await page.waitForSelector(".watch", { timeout: 15000 });
  await sleep(2000);
  const after = await bodyText();
  check("開き直すと閉じていた間の到着が履歴にある", after.includes("ORD-0003"), after.slice(0, 160));
  check("**二重に監視を始めない**（同じ設定の再接続で 1 本のまま）", watches.list().length === 1, `watches=${watches.list().length}`);
  await shot("05-reopened");

  // --- 停止 ---
  const stop = page.locator(".watch tbody tr button", { hasText: "停止" }).first();
  if (await stop.count()) {
    await stop.click();
    await sleep(1500);
  }
  check("停止すると一覧から消える", watches.list().length === 0, `watches=${watches.list().length}`);
  await shot("06-stopped");
} catch (e) {
  check("例外なく完走", false, e.message);
  log(e.stack ?? "");
} finally {
  try {
    const cleanup = await DtaqConnection.connect({
      host: sys.host,
      user: sys.signon.user,
      password,
      ...(sys.tls !== undefined ? { tls: sys.tls } : {})
    });
    await cleanup.deleteQueue(QUEUE, LIB).catch(() => undefined);
    cleanup.close();
  } catch {
    /* 後片付けの失敗は結論に影響しない */
  }
  watches.closeAll();
  await browser.close();
  server.close();
  wss.close();
}

const failed = results.filter((r) => !r.ok);
process.stdout.write(`\n${results.length - failed.length}/${results.length} passed\n`);
process.exit(failed.length === 0 ? 0 : 1);
