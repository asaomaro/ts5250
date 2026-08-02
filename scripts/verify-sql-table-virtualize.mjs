// **SQL 結果表の仮想化**が効いていることを実ブラウザで確かめる
// （`20260802-sql-table-virtualize`）。
//
// 基準線は `research-sql-table-render.mjs` で採った（同じ計測器を使う）:
//
//   200 行 × 40 列（ 8,000 セル） … 123 ms
//  1000 行 × 40 列（40,000 セル） … 582 ms
//
// 見るのは速度だけではない。**行を間引くと `table-layout: auto` が幅を決められなくなる**
// ので、スクロールで列幅が動かないことと、スクロールバーが全行を映すことを併せて見る。
//
// 前提: npm run build 済み。`connections.json` に実機。
// 実行: AS400_PASSWORD=... node scripts/verify-sql-table-virtualize.mjs
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
const PORT = 3492;
const TMP = process.env.SQLVIRT_TMP ?? "/tmp/as400-verify-sql-virtualize";
mkdirSync(TMP, { recursive: true });
let pass = 0;
let fail = 0;
const check = (cond, msg) => {
  if (cond) { pass++; log(`  PASS ${msg}`); } else { fail++; log(`  FAIL ${msg}`); }
};

/** 基準線（仮想化する前に同じ計測器で採った値） */
const BASELINE = { 200: 123, 1000: 582 };
const COLS = 40;
function wideSelect(rows, cols = COLS) {
  const items = [];
  for (let i = 1; i <= cols; i++) {
    const len = 6 + (i % 7) * 4;
    items.push(`CAST(REPEAT('C${String(i).padStart(2, "0")}x', ${Math.ceil(len / 5)}) AS CHAR(${len})) AS C${i}`);
  }
  // 表を作らない（後片付けが要らない）
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
  version: "verify",
  webRoot: "packages/web-ui/dist"
});
const wss = new WebSocketServer({ noServer: true });
const server = serve({ fetch: app.fetch, port: PORT, websocket: { server: wss } });
await sleep(600);

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1500, height: 900 } });
page.on("pageerror", (e) => log("PAGEERR " + e.message));

/** research と**同じ計測器**（比べるものが違うと数字が意味を持たない） */
const INSTRUMENT = `
window.__m = { t0: 0, t1: 0, rows: 0 };
if (!window.__patched) {
  window.__patched = true;
  const origFetch = window.fetch;
  window.fetch = async (...a) => {
    const res = await origFetch(...a);
    if (!String(a[0]).includes("/api/host/sql")) return res;
    const text = await res.text();
    window.__m.t0 = performance.now();
    return new Response(text, { status: res.status, headers: res.headers });
  };
}
/**
 * **2 つの時刻を採る**（この中は template literal なのでバッククォートを書かない）。
 *
 * first   … 行が 1 つでも見えた最初のフレーム＝利用者が表を見た瞬間。
 *           基準線（全行が出揃った時刻）と比べるのはこちら
 * settled … 窓が確定するまで（1 枚目の固定数 64 行 → 測ってから実際の窓へ）。
 *           ここまで待つと rAF 2 枚ぶん余計に乗るので、基準線と並べると不公平になる
 */
window.__waitPainted = () => new Promise((resolve) => {
  let last = -1;
  let still = 0;
  let first = 0;
  const rows = () => document.querySelectorAll(".sql-pane tbody tr.data").length;
  const tick = () => {
    if (!window.__m.t0) { requestAnimationFrame(tick); return; }
    const n = rows();
    if (n > 0 && !first) {
      void document.querySelector(".sql-pane table").getBoundingClientRect();
      first = performance.now();
    }
    if (n > 0 && n === last) still++; else still = 0;
    last = n;
    if (still >= 2) {
      void document.querySelector(".sql-pane table").getBoundingClientRect();
      requestAnimationFrame(() => {
        resolve({ t0: window.__m.t0, first, settled: performance.now(), rows: n });
      });
      return;
    }
    requestAnimationFrame(tick);
  };
  tick();
});
`;

async function measure(rows) {
  await page.evaluate(INSTRUMENT);
  await page.locator(".sql-pane textarea").fill(wideSelect(rows));
  await page.selectOption(".sql-pane label:has-text('件') select", String(rows));
  const waiting = page.evaluate("window.__waitPainted()");
  await page.click(".sql-pane header button:has-text('実行')");
  const m = await Promise.race([waiting, sleep(60_000).then(() => null)]);
  if (!m) return { rows, ms: -1, settled: -1, domRows: 0 };
  return { rows, ms: Math.round(m.first - m.t0), settled: Math.round(m.settled - m.t0), domRows: m.rows };
}

async function probe(scrollTop) {
  return page.evaluate(async (top) => {
    const sc = document.querySelector(".sql-pane .rows-scroll");
    if (top !== null) {
      sc.scrollTop = top;
      sc.dispatchEvent(new Event("scroll"));
      // **窓の更新は rAF で間引いてある。** すぐ読むと前の窓を見る
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    }
    void sc.getBoundingClientRect();
    const ths = [...document.querySelectorAll(".sql-pane thead th")];
    const nums = [...document.querySelectorAll(".sql-pane tbody tr.data td.rownum")].map((t) => t.textContent);
    return {
      domRows: document.querySelectorAll(".sql-pane tbody tr.data").length,
      spacers: document.querySelectorAll(".sql-pane tbody tr.spacer").length,
      scrollHeight: sc.scrollHeight,
      clientHeight: sc.clientHeight,
      widths: ths.map((t) => Math.round(t.getBoundingClientRect().width)),
      firstNum: nums[0] ?? "",
      lastNum: nums[nums.length - 1] ?? ""
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

  log("### 1. 初回描画（40 列）— 仮想化の前後\n");
  log("  行数    セル数   仮想化前 →  仮想化後   DOM 行");
  for (const rows of [200, 1000]) {
    const m = await measure(rows);
    const before = BASELINE[rows];
    log(
      `  ${String(rows).padStart(4)}  ${String(rows * COLS).padStart(8)}  ` +
        `${String(before).padStart(6)} ms → ${String(m.ms).padStart(4)} ms   ${m.domRows}` +
        `（窓の確定まで ${m.settled} ms）`
    );
    // **閾値は動機に合わせる。** 1000 行（0.6 秒固まる）を潰すのがこの作業の目的で、
    // 200 行は元から実用域だった。残りは表ではなく応答の解析と反応性の設定なので、
    // 仮想化では減らない——「半分以下」を全部に課すのは的外れな検査になる
    check(m.ms > 0 && m.ms < before, `${rows} 行が速くなる（${before} → ${m.ms} ms）`);
    if (rows >= 1000) {
      check(m.ms < before / 3, `**1000 行が 1/3 以下になる**（${before} → ${m.ms} ms）`);
    }
    check(m.domRows > 0 && m.domRows < rows, `**描いているのは一部だけ**（${m.domRows} / ${rows} 行）`);
    await sleep(400);
  }

  // 以降は 1000 行の状態で見る
  log("\n### 2. スクロールしても列幅が動かない");
  const top = await probe(0);
  const mid = await probe(8000);
  const bottom = await probe(1e7);
  const same = JSON.stringify(top.widths) === JSON.stringify(mid.widths) &&
    JSON.stringify(mid.widths) === JSON.stringify(bottom.widths);
  check(same, "先頭・中間・最下部で列幅が一致する");
  log(`  先頭 5 列: ${top.widths.slice(0, 5).join(" / ")}`);
  if (!same) {
    log(`  中間 5 列: ${mid.widths.slice(0, 5).join(" / ")}`);
    log(`  最下 5 列: ${bottom.widths.slice(0, 5).join(" / ")}`);
  }

  log("\n### 3. スクロールバーが全行を映す");
  // 詰め物で高さを保っているか。1000 行 × 行高 ≒ 24px なら 20,000px 以上あるはず
  log(`  scrollHeight=${top.scrollHeight} clientHeight=${top.clientHeight} 詰め物=${top.spacers}`);
  check(top.scrollHeight > top.clientHeight * 10, `全行ぶんの高さがある（${top.scrollHeight}px）`);
  check(top.spacers > 0, "詰め物の行が入っている");

  log("\n### 4. 行番号が通し番号（間引いてもずれない）");
  log(`  先頭では ${top.firstNum} … ${top.lastNum}`);
  log(`  中間では ${mid.firstNum} … ${mid.lastNum}`);
  check(top.firstNum === "1", "先頭は 1 から");
  check(Number(mid.firstNum) > 100, `中間では大きい番号から始まる（${mid.firstNum}）`);
  check(Number(mid.lastNum) > Number(mid.firstNum), "番号が昇順");

  log("\n### 5. 手動リサイズが効く");
  const before = (await probe(0)).widths[1];
  await page.evaluate(() => {
    const grip = document.querySelectorAll(".sql-pane thead .col-grip")[0];
    const at = (type, x) => grip.dispatchEvent(new MouseEvent(type, { clientX: x, bubbles: true, cancelable: true }));
    at("pointerdown", 200);
    at("pointermove", 500);
    at("pointerup", 500);
  });
  await sleep(200);
  const after = (await probe(0)).widths[1];
  check(after > before, `ドラッグで広がる（${before} → ${after} px）`);

  log("\n### 6. 下端まで送ると読み足しが起きる");
  const more = await page.evaluate(async () => {
    const sc = document.querySelector(".sql-pane .rows-scroll");
    const n0 = document.querySelector(".sql-pane .more")?.textContent ?? "";
    sc.scrollTop = sc.scrollHeight;
    sc.dispatchEvent(new Event("scroll"));
    await new Promise((r) => setTimeout(r, 2500));
    return { n0, n1: document.querySelector(".sql-pane .more")?.textContent ?? "" };
  });
  log(`  前: ${more.n0.trim().slice(0, 60)}`);
  log(`  後: ${more.n1.trim().slice(0, 60)}`);
  check(more.n1.length > 0, "読み足しの案内が出ている（経路が生きている）");

  log("\n### 7. 全角の列幅（**全角は半角の 2 倍とは限らない**）");
  // `IBM Plex Mono` は CJK の字形を持たず代替フォントが描く。2 と決め打つと
  // 日本語の列だけ広くなる。**実際に描かれた列幅**が中身にちょうど足りるかを見る
  const JP = "日本語テキスト見本";
  await page.evaluate(INSTRUMENT);
  await page.locator(".sql-pane textarea").fill(
    `SELECT '${JP}' AS J FROM QSYS2.SYSCOLUMNS FETCH FIRST 5 ROWS ONLY`
  );
  const jpWait = page.evaluate("window.__waitPainted()");
  await page.click(".sql-pane header button:has-text('実行')");
  await Promise.race([jpWait, sleep(30_000)]);
  await sleep(300);
  const jp = await page.evaluate((text) => {
    const th = document.querySelectorAll(".sql-pane thead th")[1];
    const colW = th ? th.getBoundingClientRect().width : 0;
    // 同じフォントで中身そのものを測る（これが「ちょうど足りる幅」）
    const el = document.createElement("span");
    el.textContent = text;
    el.style.cssText =
      "position:absolute;visibility:hidden;white-space:pre;font-family:var(--mono);font-size:13px";
    document.body.appendChild(el);
    const natural = el.getBoundingClientRect().width;
    el.remove();
    const cell = document.querySelector(".sql-pane tbody tr.data td:nth-child(2)");
    return { colW, natural, shown: cell ? cell.textContent.trim() : "" };
  }, JP);
  if (!jp.shown) log(`  画面: ${(await page.locator(".sql-pane").innerText()).slice(0, 200).replace(/\n+/g, " / ")}`);
  log(`  中身の実寸 ${jp.natural.toFixed(1)}px ＋ 余白 17px ＝ ${(jp.natural + 17).toFixed(1)}px`);
  log(`  実際の列幅 ${jp.colW.toFixed(1)}px（表示: ${jp.shown}）`);
  check(jp.shown === JP, "日本語がそのまま出る");
  check(jp.colW >= jp.natural + 10, `**切れない**（列幅 ${jp.colW.toFixed(1)} ≧ 中身 ${jp.natural.toFixed(1)}）`);
  check(
    jp.colW - (jp.natural + 17) < 12,
    `**広げすぎない**（差 ${(jp.colW - jp.natural - 17).toFixed(1)}px。2 倍で数えると 20px 以上開く）`
  );

} catch (e) {
  fail++;
  log(`例外: ${e?.stack ?? e}`);
} finally {
  await browser.close();
  server.close?.();
}

log(`\n${fail === 0 ? "OK" : "NG"} — ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
