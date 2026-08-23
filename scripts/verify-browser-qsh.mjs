// 実ブラウザ（web-ui）で実機の **QSH（Qshell）** が使えるか検証する。
//
//   メニューで QSH → **画面が出る**（従来はここで「待機中」のまま固まった）
//   → コマンドを打つ → **出力が読める** → 続けて打つと**前の出力が流れる** → F3 で終了
//
// これは `ESC 0x03`（SAVE PARTIAL SCREEN）への応答が要る経路。
// 応答を返さないとホストは次を送ってこない——**利用者には「ホストから応答がない」としか見えない**
// ので、単体テストではなく実物で確かめる（`20260730-qsh-save-partial-screen`）。
//
// 前提: npm run build＋web-ui の vite build 済み。`connections.json` に実機。
// 実行: AS400_PASSWORD=... node scripts/verify-browser-qsh.mjs
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
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
const PORT = 3489;
const TMP = process.env.QSH_TMP ?? "/tmp/as400-verify-qsh";
const SHOTS = `${TMP}/shots`;
mkdirSync(SHOTS, { recursive: true });

const results = [];
const check = (n, ok, d = "") => {
  results.push({ n, ok });
  process.stdout.write(`${ok ? "OK  " : "NG  "} ${n}${d ? ` — ${d}` : ""}\n`);
};

const cfg = JSON.parse(readFileSync("connections.json", "utf8"));
const sys = cfg.systems.find((s) => s.name === (process.env.AS400_SYSTEM ?? "AS400"));
if (!process.env.AS400_PASSWORD) {
  log("AS400_PASSWORD が未設定です");
  process.exit(1);
}
// **設定に書くのは環境変数の名前だけ**（値はファイルに落とさない）
sys.signon = { user: sys.signon.user, passwordEnv: "AS400_PASSWORD" };
// 装置名は**実機に登録済みのもの**を使う（自動構成が無効で、新しい名前は拒否される）。
// 使用中だと接続できないので、空いている名前を順に試せるよう表示セッションを複数用意する
// **設定にある装置名（DEV1）を先頭に置く**。実機に登録済みで、これが空いていれば一番早い。
// 続く WEBSF* は他のスクリプトと共用しているので、直前の検証が掴んでいると使えない
const DEV_POOL = (process.env.QSH_DEVNAMES ?? "DEV1,WEBSF0,WEBSF1,WEBSF2,WEBSF3,WEBSF4").split(",");
const display = cfg.sessions.find((s) => s.system === sys.id && s.sessionType === "display");
cfg.sessions = cfg.sessions.filter((s) => s !== display);
for (const [i, dev] of DEV_POOL.entries()) {
  cfg.sessions.push({
    ...display,
    id: `qsh-e2e-${i}`,
    name: `QSH E2E ${dev}`,
    deviceName: dev
  });
}
mkdirSync(TMP, { recursive: true });
const tmpCfg = `${TMP}/conn-qsh.json`;
writeFileSync(tmpCfg, JSON.stringify(cfg));

const app = buildApp({
  sessions: new SessionManager(),
  resolver: new ConfigResolver(
    ServerConfigStore.fromFile(tmpCfg),
    new PersonalConfigStore({ systems: [], sessions: [] })
  ),
  version: "verify",
  webRoot: "packages/web-ui/dist"
});
const wss = new WebSocketServer({ noServer: true });
const server = serve({ fetch: app.fetch, port: PORT, websocket: { server: wss } });
await sleep(600);

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1200, height: 800 } });
page.on("pageerror", (e) => log("PAGEERR " + e.message));
const shot = async (name) => {
  await page.screenshot({ path: `${SHOTS}/${name}.png` });
  log(`shot: ${SHOTS}/${name}.png`);
};
const bodyText = () => page.locator("body").innerText();
const has = async (t) => (await bodyText()).includes(t);
/** 画面の入力欄（読み取り専用でないもの）。既存 E2E と同じ作法 */
const inputs = () => page.locator("input.grid-input:not([readonly])");
const clickEnter = async () => {
  const b = page.getByText("⏎ 実行", { exact: false }).first();
  if (await b.count()) await b.click();
  else await page.keyboard.press("Enter");
};

/** 最後の入力欄へ打って Enter（コマンド行・QSH の `===>` はどちらも最後の欄） */
async function runCmd(text) {
  const el = inputs().last();
  await el.click();
  await page.keyboard.press("Home");
  await page.keyboard.type(text, { delay: 15 });
  await clickEnter();
}

try {
  // **空いている装置名を順に試す**（使用中だとホストが接続を切る）。
  // 失敗したら**ページごと開き直す**——画面が出ていない状態のパンくずは押せない
  let connected = false;
  for (const dev of DEV_POOL) {
    await page.goto(`http://localhost:${PORT}/`);
    await page.waitForSelector(".launcher", { timeout: 20000 });
    await page.click(".card:has-text('実機') >> button:has-text('選択')");
    await page.waitForSelector(`.card:has-text('QSH E2E ${dev}')`, { timeout: 10000 });
    await page.click(`.card:has-text('QSH E2E ${dev}') >> button:has-text('接続')`);
    try {
      // **画面（入力欄）が出たかで見る。** 本文の文字で見ると、ランチャーの機能カード
      // （「ユーザー」等）に当たって**繋がっていないのに成功と誤判定する**（実際に踏んだ）。
      // 併せて接続失敗の帯（SESSION_CLOSED）が出ていないことも確かめる
      await page.waitForFunction(
        () =>
          !/SESSION_CLOSED/.test(document.body.innerText) &&
          document.querySelector("input.grid-input") !== null,
        { timeout: 20000 }
      );
      connected = true;
      log(`装置名 ${dev} で接続`);
      break;
    } catch {
      log(`装置名 ${dev} は使えなかった（使用中）`);
    }
  }
  check("表示セッションに接続できた", connected);
  if (!connected) throw new Error("接続できる装置名が無い");
  await sleep(900);
  await shot("01-connected");

  // **サインオンと回復画面はループの中で**（先に 1 回だけ試すと取りこぼす。既存 E2E の教訓）
  for (let i = 0; i < 20; i++) {
    if (await has("メインメニュー")) break;
    if (await has("対話式ジョブの回復")) {
      const el = inputs().last();
      await el.click();
      await page.keyboard.press("Home");
      await page.keyboard.type("90", { delay: 30 });
      await clickEnter();
    } else if ((await has("サイン")) && (await has("ユーザー"))) {
      const u = inputs().nth(0);
      await u.click();
      await page.keyboard.press("Home");
      await page.keyboard.type(sys.signon.user, { delay: 20 });
      const p = inputs().nth(1);
      await p.click();
      await page.keyboard.press("Home");
      await page.keyboard.type(process.env.AS400_PASSWORD, { delay: 20 });
      await clickEnter();
    } else await clickEnter();
    await sleep(1400);
  }
  check("メニューに到達した", await has("メインメニュー"));
  await shot("02-menu");

  // --- QSH を起動 ---
  await runCmd("QSH");
  await sleep(6000);
  const started = await has("QSH コマンド入力");
  check("**QSH が起動する**（従来はここで待機のまま固まった）", started, (await bodyText()).slice(0, 60));
  await shot("03-qsh");

  if (started) {
    // --- コマンドを打って出力を見る ---
    await runCmd("ls -l /");
    await sleep(6000);
    check("**コマンドの出力が読める**", (await has("usr")) || (await has("tmp")));
    await shot("04-ls");

    // --- 続けて打つと前の出力が流れる ---
    await runCmd("echo AAA; echo BBB");
    await sleep(6000);
    check("続けて実行できる（出力が流れる）", (await has("AAA")) && (await has("BBB")));
    await shot("05-echo");

    // --- 終了 ---
    // **ボタンを指定して押す**（`getByText("F3")` だと画面の凡例「F3= 終了」に当たる。実際に踏んだ）
    const f3 = page.locator("button", { hasText: "F3" }).first();
    if (await f3.count()) await f3.click();
    else await page.keyboard.press("F3");
    // 抜けるまで待つ（ホストの応答を待たずに見ると「まだ QSH」と誤判定する）
    await page
      .waitForFunction(() => !document.body.innerText.includes("QSH コマンド入力"), { timeout: 20000 })
      .catch(() => undefined);
    check("F3 で QSH を抜けられる", !(await has("QSH コマンド入力")), (await bodyText()).slice(0, 60));
    await shot("06-exit");
  }
} catch (e) {
  check("例外なく完走", false, e.message);
  log(e.stack ?? "");
} finally {
  await browser.close();
  server.close();
  wss.close();
}

const failed = results.filter((r) => !r.ok);
process.stdout.write(`\n${results.length - failed.length}/${results.length} passed\n`);
process.exit(failed.length === 0 ? 0 : 1);
