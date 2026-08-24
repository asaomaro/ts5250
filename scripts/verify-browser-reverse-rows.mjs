// **縦に並んだ反転（背景色）が隙間なく繋がって見えるか**を実画素で確かめる。
//
// 行間（line-height の余白）は文字要素の背景では塗られない（CSS の仕様）ので、
// 反転が複数行続くと行と行の間に地色が横線として並ぶ。ACS は隙間なく繋がって見えるため、
// `.a-reverse`（web-ui）と `.a-r`（MCP の HTML）は box-shadow で上下へ半行送りぶん
// 同じ色を延ばしている。**jsdom は描画しないので、隙間そのものはここでしか測れない**
// （単体テストが見ているのは *隙間を作らない書き方*）。
//
// 出口が 2 つ（web-ui と MCP の HTML）あるので、**同じ物差しで両方**測る:
//   1. web-ui … 実機に接続して REVCL を呼び、画面の実画素を測る
//   2. MCP    … 同じ画面を `get_screen_html` で出し、その HTML を同じブラウザで測る
//
// 検証資材は scripts/build-revtest.mjs が作る <LIB>/REVTST ＋ REVCL。
//
// 実行:
//   npm run build && npm run build -w @ts5250/web-ui
//   node --env-file=.env --env-file=.env.verify scripts/verify-browser-reverse-rows.mjs
// 任意: SHOT_OUT（画像・HTML の出力先。既定 /tmp）
//
// 副作用: 実機へ表示セッションを 1 本張り、テスト画面を呼ぶだけ。**装置名は指定せず
// ホストに採らせる**（共有機なので既存の装置名を奪わない）。オブジェクトは作らない。
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serve } from "@hono/node-server";
import { WebSocketServer } from "ws";
import { buildApp, SessionManager, ServerConfigStore, PersonalConfigStore, ConfigResolver } from "@ts5250/server";
import { SecretCrypto } from "../packages/server/dist/secret-crypto.js";
import { renderScreenHtml } from "@ts5250/tn5250";
import { chromium } from "playwright";

const host = process.env.AS400_HOST;
const user = process.env.AS400_USER;
if (!host || !user || !process.env.AS400_PASSWORD) {
  process.stderr.write("AS400_HOST / AS400_USER / AS400_PASSWORD を環境変数で渡してください\n");
  process.exit(2);
}
const LIB = process.env.AS400_LIB ?? "TESTLIB";
const OUT = process.env.SHOT_OUT ?? tmpdir();
const PORT = Number(process.env.PORT ?? 3493);
const BLOCK_ROWS = 8; // build-revtest.mjs の BLOCK_ROWS と揃える

const log = (s) => process.stdout.write(s + "\n");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
const check = (cond, msg) => { if (cond) { pass++; log(`  PASS ${msg}`); } else { fail++; log(`  FAIL ${msg}`); } };

/**
 * **反転が縦に続く塊の中に地色の画素が何本あるか**を数える。
 *
 * 画像の解析はブラウザにやらせる——撮った PNG を data URI で読み直し、canvas へ描いて
 * `getImageData` で読む。Node 側に画像デコーダーを持ち込まずに実画素へ届く。
 *
 * 測る筋は**空白だけの反転**の中央（`build-revtest.mjs` が空白の定数にしてあるのはこのため）。
 * 文字があるとその画素は反転の文字色＝地色と同じ値になり、隙間と見分けが付かない。
 */
async function measureGaps(page, revSel) {
  const shot = await page.locator(".grid").screenshot();
  const uri = "data:image/png;base64," + shot.toString("base64");
  return page.evaluate(
    ({ uri, revSel }) =>
      new Promise((resolve) => {
        const grid = document.querySelector(".grid");
        const gr = grid.getBoundingClientRect();
        // 反転の要素を「左端と幅が揃った縦の並び」でまとめ、いちばん背の高い塊を測る
        const boxes = [...grid.querySelectorAll(revSel)]
          .map((el) => el.getBoundingClientRect())
          .filter((r) => r.width > 4 && r.height > 4)
          .map((r) => ({ left: r.left - gr.left, top: r.top - gr.top, w: r.width, h: r.height }));
        const groups = new Map();
        for (const b of boxes) {
          const key = `${Math.round(b.left)}:${Math.round(b.w)}`;
          if (!groups.has(key)) groups.set(key, []);
          groups.get(key).push(b);
        }
        // **縦に途切れずに続くものだけを 1 つの塊にする。** 桁と幅が同じでも間に普通の行を
        // 挟んでいれば別の塊——ひと続きとして測ると、その普通の行がまるごと「隙間」に化ける
        // （別色の塊を下に置いてあるので実際に踏んだ）。行送りの半分を切れ目の目安にする。
        const runs = [];
        for (const g of groups.values()) {
          g.sort((a, b) => a.top - b.top);
          let run = [g[0]];
          for (let i = 1; i < g.length; i++) {
            const prev = run[run.length - 1];
            if (g[i].top - (prev.top + prev.h) <= prev.h * 0.5) run.push(g[i]);
            else { runs.push(run); run = [g[i]]; }
          }
          runs.push(run);
        }
        const block = runs.sort((a, b) => b.length - a.length)[0] ?? [];
        if (block.length < 2) { resolve({ error: "反転の塊が見つからない", rows: block.length }); return; }

        const img = new Image();
        img.onload = () => {
          const cv = document.createElement("canvas");
          cv.width = img.naturalWidth;
          cv.height = img.naturalHeight;
          const ctx = cv.getContext("2d");
          ctx.drawImage(img, 0, 0);
          const scale = img.naturalWidth / gr.width;
          const px = (x, y) => {
            const d = ctx.getImageData(Math.round(x), Math.round(y), 1, 1).data;
            return [d[0], d[1], d[2]];
          };
          const dist = (a, b) => Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) + Math.abs(a[2] - b[2]);
          const first = block[0], last = block[block.length - 1];
          const x = (first.left + first.w / 2) * scale;
          const yTop = (first.top + first.h / 2) * scale;
          const yBottom = (last.top + last.h / 2) * scale;
          const cell = px(x, yTop); // 反転の背景色（塊の中）
          // 地色は grid 自身の背景（＝隙間から透けて見える色）
          const m = /rgba?\(([^)]+)\)/.exec(getComputedStyle(grid).backgroundColor);
          const bg = m ? m[1].split(",").slice(0, 3).map((v) => parseFloat(v)) : [0, 0, 0];

          // **2 段階で数える。** `gaps` は地色そのもの（＝完全に塗り残した画素）、
          // `blend` は反転色から目に見えて外れた画素——境目が半端な位置に載ると、
          // 塗り切っていても混ざった 1 本が残ることがある（フォントと拡大率で出たり出なかったりする）。
          const BLEND = 30; // 反転色との差（|ΔR|+|ΔG|+|ΔB|）がこれを超えたら「濁っている」
          let gaps = 0, run = 0, maxRun = 0, blend = 0, blendRun = 0, maxBlendRun = 0;
          for (let y = yTop; y <= yBottom; y++) {
            const p = px(x, y);
            if (dist(p, bg) < dist(p, cell)) { gaps++; run++; maxRun = Math.max(maxRun, run); }
            else run = 0;
            if (dist(p, cell) > BLEND) { blend++; blendRun++; maxBlendRun = Math.max(maxBlendRun, blendRun); }
            else blendRun = 0;
          }
          resolve({
            rows: block.length,
            height: Math.round(yBottom - yTop),
            gaps, maxRun, blend, maxBlendRun,
            cell: cell.join(","), bg: bg.map(Math.round).join(",")
          });
        };
        img.onerror = () => resolve({ error: "撮った画像を読み込めない" });
        img.src = uri;
      }),
    { uri, revSel }
  );
}

/**
 * **判定は「地色が透けていないか」だけに絞る。**
 *
 * `blend`（濁った画素）は情報。境目が半端な位置に載ると、塗り切っていても同系色の 1 CSS px が
 * 残ることがあり、フォントと拡大率で出たり出なかったりする（実測: 0.125em では 7 か所中 3 か所、
 * 0.2em では 0。ただし 0.2em は隣の行の字の領域へ食い込む）。
 * **症状は「地色の横線が並ぶ」こと**なので、そこを 0 で固定し、混色は数えて出すだけにする。
 */
const report = (label, r, shotPath) => {
  if (r.error) { check(false, `${label}: ${r.error}`); return; }
  log(`  ${label}: 反転 ${r.rows} 行 / 塊の高さ ${r.height}px / 地色の画素 ${r.gaps}（最長 ${r.maxRun} 連続） / 濁った画素 ${r.blend}（最長 ${r.maxBlendRun} 連続） 反転色=${r.cell} 地色=${r.bg}`);
  if (shotPath) log(`  画像: ${shotPath}`);
  check(r.rows === BLOCK_ROWS, `${label}: 反転が ${BLOCK_ROWS} 行そろって見つかる（実際 ${r.rows} 行）`);
  // **隙間はゼロを要求する。** box-shadow は境界まで同じ色を塗り切るので、直っていれば
  // 中間色すら出ない（直す前は行の境目ごとに 1〜数画素の地色が並ぶ）。
  check(r.gaps === 0, `${label}: 塊の中に地色の画素が無い（実際 ${r.gaps} 画素）`);
};

const work = mkdtempSync(join(tmpdir(), "revrows-"));
const cfgPath = join(work, "profiles.json");
// **パスワードはファイルに書かない**——`passwordEnv` で環境変数を指す
writeFileSync(
  cfgPath,
  JSON.stringify({
    systems: [{ id: "AS400", name: "AS400", host, ccsid: 930, signon: { user, passwordEnv: "AS400_PASSWORD" } }],
    sessions: [{ id: "DSP", name: "DSP", system: "AS400", sessionType: "display", screenSize: "24x80" }]
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
const page = await browser.newPage({ viewport: { width: 1400, height: 900 }, deviceScaleFactor: 2 });

try {
  await page.goto(`http://localhost:${PORT}/`);
  await page.waitForSelector(".launcher", { timeout: 20000 });
  // システムが 1 つならランチャーは最初からセッション一覧を出す（「選択」は現れない）
  if ((await page.locator(".card:has-text('DSP')").count()) === 0) {
    await page.click(".card:has-text('AS400') >> button:has-text('選択')");
    await page.waitForSelector(".card:has-text('DSP')", { timeout: 10000 });
  }
  let opened = false;
  for (let a = 1; a <= 6 && !opened; a++) {
    await page.click(".card:has-text('DSP') >> button:has-text('接続')");
    try { await page.waitForSelector("input.grid-input", { timeout: 20000 }); opened = true; }
    catch { log(`  （装置が空くのを待つ ${a}）`); await sleep(9000); }
  }
  check(opened, "実機へ接続して画面が出る");
  if (!opened) throw new Error("接続できない");
  await sleep(1200);

  for (let i = 0; i < 8; i++) {
    const t = await page.locator(".pane").innerText();
    if (t.includes("コマンドを入力") || t.includes("選択項目またはコマンド")) break;
    if (t.includes("サイン・オン")) {
      await page.keyboard.type(user);
      await page.keyboard.press("Tab");
      await page.keyboard.type(process.env.AS400_PASSWORD);
    } else if (t.includes("回復")) {
      await page.keyboard.type("90");
    }
    await page.keyboard.press("Enter");
    await sleep(2500);
  }

  log("\n### 1. web-ui の画面");
  await page.keyboard.type(`CALL ${LIB}/REVCL`);
  await page.keyboard.press("Enter");
  await sleep(3000);
  const paneShot = join(OUT, "reverse-rows-webui.png");
  await page.locator(".pane").screenshot({ path: paneShot });
  check((await page.locator(".pane").innerText()).includes("REVERSE ROWS"), "テスト画面が出ている");
  report("web-ui（既定フォント）", await measureGaps(page, ".a-reverse"), paneShot);

  // **隙間が出るかはフォントの縦メトリクス次第。** 行間が塗られない量は
  // 「行送り（1.25em） − 文字要素の内容領域」で決まり、内容領域はフォントの ascent+descent。
  // この環境で既定に当たる Noto Sans Mono CJK JP は内容領域が行送りより**大きい**ので
  // 直す前でも隙間が出ない（実測 29px > 25px）。総称 monospace（＝ここでは DejaVu 系）は
  // 内容領域が 1em ちょうどで、半行送り 2 つぶん＝0.25em がまるごと隙間になる。
  // **症状が出る側でも埋まっていること**を見るために、画面フォントを差し替えてもう一度測る。
  await page.addStyleTag({ content: ":root{--screen-mono:monospace}" });
  await sleep(600);
  const monoShot = join(OUT, "reverse-rows-webui-mono.png");
  await page.locator(".pane").screenshot({ path: monoShot });
  report("web-ui（monospace）", await measureGaps(page, ".a-reverse"), monoShot);

  // **MCP と同じ HTML を、同じセッションの画面から出す。**
  // `get_screen_html`（MCP ツール）が呼ぶのは `renderScreenHtml` そのもの——
  // ここで同じ関数へ同じスナップショットを渡し、出た HTML をブラウザで測る。
  log("\n### 2. MCP が出す HTML（renderScreenHtml）");
  const entry = sessions.list()[0];
  const html = renderScreenHtml(entry.session.snapshot(), {
    capturedAt: new Date().toISOString(),
    host,
    title: "REVTST 反転の連続"
  });
  const htmlPath = join(OUT, "reverse-rows-mcp.html");
  writeFileSync(htmlPath, html);
  log(`  出力: ${htmlPath}（${html.length} バイト）`);
  const htmlPage = await browser.newPage({ viewport: { width: 1200, height: 800 }, deviceScaleFactor: 2 });
  await htmlPage.goto("file://" + htmlPath);
  await htmlPage.waitForSelector(".grid", { timeout: 10000 });
  await sleep(400);
  const mcpShot = join(OUT, "reverse-rows-mcp.png");
  await htmlPage.locator(".crt").screenshot({ path: mcpShot });
  check(html.includes("REVERSE ROWS"), "MCP の HTML にテスト画面が入っている");
  report("MCP HTML", await measureGaps(htmlPage, ".a-r"), mcpShot);
  await htmlPage.close();

  // 画面を閉じてコマンド行へ戻す
  for (let i = 0; i < 4; i++) {
    if ((await page.locator(".pane").innerText()).includes("コマンドを入力")) break;
    await page.keyboard.press("Enter");
    await sleep(2200);
  }
} catch (err) {
  check(false, err instanceof Error ? err.message : String(err));
} finally {
  await browser.close();
  await new Promise((r) => server.close(r));
  rmSync(work, { recursive: true, force: true });
}

log(`\n${fail === 0 ? "すべて PASS" : `FAIL ${fail} 件`}（PASS ${pass}）`);
process.exit(fail === 0 ? 0 : 1);
