// **SQL 結果表の初回描画コストを実ブラウザで測る**（`20260802-sql-table-virtualize`）。
//
// backlog は「200 行 × 40 列（8,000 セル）で 100ms 前後」と書いているが、その数字は
// `20260723` 時点のもの。**改善を主張するには基準線が要る**ので、まず現状を測る。
//
// jsdom では測れない（レイアウトを計算しない）。実ブラウザ＋実機で通す。
//
// 前提: npm run build 済み。`connections.json` に実機。
// 実行: AS400_PASSWORD=... node scripts/research-sql-table-render.mjs
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

const log = (s) => process.stdout.write(s + "\n");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const PORT = 3491;
const TMP = process.env.SQLRENDER_TMP ?? "/tmp/as400-research-sql-render";
mkdirSync(TMP, { recursive: true });

/** 40 列の SELECT を組む。**列幅がばらつくよう長さを変える**（`auto` の効き方を見るため） */
const COLS = 40;
function wideSelect(rows, cols = COLS) {
  const items = [];
  for (let i = 1; i <= cols; i++) {
    const len = 6 + (i % 7) * 4; // 6〜30 文字のばらつき
    items.push(`CAST(REPEAT('C${String(i).padStart(2, "0")}x', ${Math.ceil(len / 5)}) AS CHAR(${len})) AS C${i}`);
  }
  // 行の供給元は**システムカタログ**（表を作らない＝後片付けが要らない）
  return `SELECT ${items.join(", ")} FROM QSYS2.SYSCOLUMNS FETCH FIRST ${rows} ROWS ONLY`;
}

const cfg = JSON.parse(readFileSync("connections.json", "utf8"));
const sys = cfg.systems.find((s) => s.name === "実機");
if (!process.env.AS400_PASSWORD) {
  log("AS400_PASSWORD が未設定です");
  process.exit(1);
}
// **書くのは環境変数の名前だけ**——値はファイルに落とさない
sys.signon = { user: sys.signon.user, passwordEnv: "AS400_PASSWORD" };
const tmpCfg = `${TMP}/conn.json`;
writeFileSync(tmpCfg, JSON.stringify(cfg));

const resolver = new ConfigResolver(
  ServerConfigStore.fromFile(tmpCfg),
  new PersonalConfigStore({ systems: [], sessions: [] })
);
const app = buildApp({
  sessions: new SessionManager(),
  resolver,
  version: "research",
  webRoot: "packages/web-ui/dist"
});
const wss = new WebSocketServer({ noServer: true });
const server = serve({ fetch: app.fetch, port: PORT, websocket: { server: wss } });
await sleep(600);

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1500, height: 900 } });
page.on("pageerror", (e) => log("PAGEERR " + e.message));

/**
 * ページの中に計測器を仕込む。
 *
 * `t0` = SQL の応答を読み終えた時刻（`fetch` を包んで拾う）
 * `t1` = tbody の行が出揃い、**レイアウトまで終わった**時刻
 *        （`getBoundingClientRect` で強制的に確定させてから読む）
 */
const INSTRUMENT = `
window.__m = { t0: 0, t1: 0, rows: 0 };
if (!window.__patched) {
  window.__patched = true;
  const origFetch = window.fetch;
  window.fetch = async (...a) => {
    const res = await origFetch(...a);
    const url = String(a[0]);
    if (!url.includes("/api/host/sql")) return res;
    // **本文を自分で読み切ってから時刻を刻む。** \`res.clone().text()\` を
    // \`.then\` で待つと、アプリが描き終えたあとに解決することがある
    // （実際それで 200 行が「0 ms」になった）。読んだ中身で新しい Response を作って返す
    const text = await res.text();
    window.__m.t0 = performance.now();
    return new Response(text, { status: res.status, headers: res.headers });
  };
}
window.__waitPainted = (want) => new Promise((resolve) => {
  const tick = () => {
    // **応答が届くまで数えない。** 前の結果が残っていると、その場で条件が成立してしまう
    if (!window.__m.t0) { requestAnimationFrame(tick); return; }
    const tb = document.querySelector(".sql-pane tbody");
    const n = tb ? tb.querySelectorAll("tr").length : 0;
    if (n >= want) {
      // **レイアウトを強制的に確定させてから**時刻を読む（描いた気になるのを防ぐ）
      void document.querySelector(".sql-pane table").getBoundingClientRect();
      requestAnimationFrame(() => {
        window.__m.t1 = performance.now();
        window.__m.rows = n;
        resolve({ ...window.__m });
      });
      return;
    }
    requestAnimationFrame(tick);
  };
  tick();
});
`;

/** 1 回ぶん測る。`want` は tbody に並ぶはずの行数 */
async function measure(rows, cols = COLS) {
  await page.evaluate(INSTRUMENT); // `__m` を毎回ゼロに戻す（`t0` の門番になる）
  const sql = wideSelect(rows, cols);
  await page.locator(".sql-pane textarea").fill(sql);
  // ページサイズを合わせる（画面から選べる 50 / 200 / 1000）
  await page.selectOption(".sql-pane label:has-text('件') select", String(rows));
  const waiting = page.evaluate(`window.__waitPainted(${rows})`);
  await page.click(".sql-pane header button:has-text('実行')");
  const m = await Promise.race([waiting, sleep(60_000).then(() => null)]);
  if (!m) return { rows, cols, ms: -1, painted: 0 };
  return { rows, cols, ms: Math.round(m.t1 - m.t0), painted: m.rows };
}

/** 描かれている行の数と、列幅（スクロールで動くか） */
async function widthsAt(scrollTop) {
  return page.evaluate((top) => {
    const sc = document.querySelector(".sql-pane .rows-scroll");
    sc.scrollTop = top;
    void sc.getBoundingClientRect();
    const ths = [...document.querySelectorAll(".sql-pane thead th")];
    return {
      domRows: document.querySelectorAll(".sql-pane tbody tr").length,
      widths: ths.map((t) => Math.round(t.getBoundingClientRect().width))
    };
  }, scrollTop);
}

try {
  await page.goto(`http://localhost:${PORT}/`);
  await page.waitForSelector(".launcher", { timeout: 20000 });
  await page.click(".card:has-text('実機') >> button:has-text('選択')");
  await page.waitForSelector(".fn:has-text('SQL')", { timeout: 10000 });
  await page.click(".fn:has-text('SQL') >> button");
  await page.waitForSelector(".sql-pane textarea", { timeout: 15000 });

  log(`### 初回描画（${COLS} 列）— 応答を読み終えてからレイアウト確定まで\n`);
  log("  行数    セル数   描画");
  for (const rows of [50, 200, 1000]) {
    const m = await measure(rows);
    log(`  ${String(m.rows).padStart(4)}  ${String(m.rows * COLS).padStart(8)}  ${m.ms < 0 ? "(時間切れ)" : `${m.ms} ms`}（DOM 行 ${m.painted}）`);
    await sleep(500);
  }

  log("\n### セル数に比例するか（列を減らして同じ行数で測る）");
  for (const cols of [8, 40]) {
    const m = await measure(1000, cols);
    log(`  1000 行 × ${String(cols).padStart(2)} 列 = ${String(1000 * cols).padStart(6)} セル → ${m.ms} ms（1 セルあたり ${(m.ms / (1000 * cols) * 1000).toFixed(1)} µs）`);
    await sleep(500);
  }

  log("\n### スクロールで列幅が動くか（いまは全行描いているので動かないはず）");
  const a = await widthsAt(0);
  const b = await widthsAt(20_000);
  log(`  DOM 行数: 先頭 ${a.domRows} / 下 ${b.domRows}`);
  const same = JSON.stringify(a.widths) === JSON.stringify(b.widths);
  log(`  列幅: ${same ? "同じ" : "**変わった**"}`);
  log(`  先頭 5 列: ${a.widths.slice(0, 5).join(" / ")} → ${b.widths.slice(0, 5).join(" / ")}`);

  log("\n### タブ切り替えの往復（KeepAlive が効いているか）");
  const t = await page.evaluate(() => {
    const t0 = performance.now();
    return new Promise((r) => requestAnimationFrame(() => r(Math.round(performance.now() - t0))));
  });
  log(`  1 フレーム: ${t} ms（参考値）`);
} catch (e) {
  log(`例外: ${e?.stack ?? e}`);
} finally {
  await browser.close();
  server.close?.();
  process.exit(0);
}
