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
// 検証資材は scripts/build-revtest.mjs が作る <LIB>/REVTST ＋ REVCL / REVCL2。
//   REVCL  … 同じ幅の帯を縦に重ねる（隙間が無いか）
//   REVCL2 … **幅の違う帯**を交互に重ねる（延ばしすぎて上下へ被っていないか）
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
// 画面2（幅違いの帯）のレイアウト。**build-revtest.mjs と同じ値**
const LAYOUT = { col: 20, wide: 32, narrow: 12, wideBands: 4, textIn: 34, textOut: 60, textLen: 12 };

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
 * **帯が上下へはみ出していないか**を測る（画面2・幅違いの帯）。
 *
 * 見るのは 2 つ:
 *   1. **塗った高さ** — 広い帯だけが届く桁（狭い帯の右側）は上下に地色しか無いので、
 *      反転色が縦に何 px 続くかがそのまま「塗った高さ」になる。これが
 *      **行送りとフォントの内容領域の大きい方**を超えたら、こちらが足した分がはみ出している。
 *      （内容領域が行送りより大きいフォントは元から隣へ被る。それはこちらの処置とは別の話なので、
 *      どちらか大きい方を上限にする。）
 *   2. **隣の行の文字が欠けていないか** — 広い帯のすぐ上下の行には、帯の中に入る桁と
 *      帯の外の桁に同じ文字が置いてある。被れば内側だけインクの画素が減る。
 */
async function measureBands(page, revSel, layout) {
  const shot = await page.locator(".grid").screenshot();
  const uri = "data:image/png;base64," + shot.toString("base64");
  return page.evaluate(
    ({ uri, revSel, layout }) =>
      new Promise((resolve) => {
        const grid = document.querySelector(".grid");
        const gr = grid.getBoundingClientRect();
        const boxes = [...grid.querySelectorAll(revSel)]
          .map((el) => el.getBoundingClientRect())
          .filter((r) => r.width > 4 && r.height > 4)
          .map((r) => ({ left: r.left - gr.left, top: r.top - gr.top, w: r.width, h: r.height }));
        if (!boxes.length) { resolve({ error: "反転が見つからない" }); return; }
        // 幅でまとめて、いちばん広い群＝広い帯
        const maxW = Math.max(...boxes.map((b) => b.w));
        const wide = boxes.filter((b) => Math.abs(b.w - maxW) < 2).sort((a, b) => a.top - b.top);
        if (wide.length < 2) { resolve({ error: `広い帯が ${wide.length} 本しか無い` }); return; }
        const charW = wide[0].w / layout.wide;
        const pitch = parseFloat(getComputedStyle(grid).lineHeight);

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
          const m = /rgba?\(([^)]+)\)/.exec(getComputedStyle(grid).backgroundColor);
          const bg = m ? m[1].split(",").slice(0, 3).map((v) => parseFloat(v)) : [0, 0, 0];
          // 広い帯だけが届く桁の中央（狭い帯の右端より右）
          const xOut = (wide[0].left + (layout.narrow + (layout.wide - layout.narrow) / 2) * charW) * scale;
          // **帯は 1 本ずつ色が違う**（build-revtest.mjs の BAND_COLORS）ので、色は帯ごとに採る。
          // 1 本目の色で全部を測ると、2 本目以降が「帯ではない」と判定されて高さが 1 画素になる。
          const cells = wide.map((b) => px(xOut, (b.top + b.h / 2) * scale));

          // 1. 塗った高さ（その帯の色が縦に続く長さ）を帯ごとに測る
          const painted = wide.map((b, i) => {
            const yc = (b.top + b.h / 2) * scale;
            const cell = cells[i];
            let up = 0, down = 0;
            while (dist(px(xOut, yc - up - 1), cell) < 30 && up < pitch * scale * 2) up++;
            while (dist(px(xOut, yc + down + 1), cell) < 30 && down < pitch * scale * 2) down++;
            return (up + down + 1) / scale; // CSS px
          });

          // 2. 隣の行の**内容領域**（字が載る帯。行送りの中央に内容領域ぶん）を切り出して数える。
          //    行間（半行送り）は上下の行で分け合う場所なので、そこまで塗るのは正しい——
          //    はみ出しかどうかは**内容領域に帯の色が入ったか**で決まる。
          const content = wide[0].h;
          const region = (rowTop, colFrom) => {
            const x0 = Math.round((wide[0].left + (colFrom - layout.col) * charW) * scale);
            const x1 = Math.round((wide[0].left + (colFrom - layout.col + layout.textLen) * charW) * scale);
            const y0 = Math.round((rowTop + (pitch - content) / 2) * scale);
            const y1 = Math.round((rowTop + (pitch + content) / 2) * scale);
            return ctx.getImageData(x0, y0, Math.max(1, x1 - x0), Math.max(1, y1 - y0)).data;
          };
          const aboveTop = wide[0].top - pitch; // 広い帯のすぐ上の行
          const belowTop = wide[wide.length - 1].top + pitch; // すぐ下の行
          // 文字の色は**帯の外**の対照から採る（地色から最も遠い画素＝インクの色）
          const inkColor = (() => {
            const d = region(aboveTop, layout.textOut);
            let best = bg, bestD = 0;
            for (let i = 0; i < d.length; i += 4) {
              const p = [d[i], d[i + 1], d[i + 2]];
              const dd = dist(p, bg);
              if (dd > bestD) { bestD = dd; best = p; }
            }
            return best;
          })();
          /**
           * 内容領域の中で「その隣の帯の色」と「文字の色」の画素を数える。
           * 上の行なら 1 本目の帯、下の行なら最後の帯——**はみ出すとしたらその色**が乗る。
           */
          const countIn = (rowTop, colFrom, cell) => {
            const d = region(rowTop, colFrom);
            let band = 0, ink = 0;
            for (let i = 0; i < d.length; i += 4) {
              const p = [d[i], d[i + 1], d[i + 2]];
              if (dist(p, cell) < 30) band++;
              if (dist(p, inkColor) < 60) ink++;
            }
            return { band, ink };
          };
          resolve({
            bands: wide.length,
            pitch: +pitch.toFixed(2),
            content: +content.toFixed(2),
            paintedMax: +Math.max(...painted).toFixed(2),
            paintedMin: +Math.min(...painted).toFixed(2),
            inkColor: inkColor.map(Math.round).join(","),
            colors: cells.map((c) => c.join(",")),
            above: { inside: countIn(aboveTop, layout.textIn, cells[0]), outside: countIn(aboveTop, layout.textOut, cells[0]) },
            below: {
              inside: countIn(belowTop, layout.textIn, cells[cells.length - 1]),
              outside: countIn(belowTop, layout.textOut, cells[cells.length - 1])
            }
          });
        };
        img.onerror = () => resolve({ error: "撮った画像を読み込めない" });
        img.src = uri;
      }),
    { uri, revSel, layout }
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

/**
 * はみ出しの報告。**上限は「行送り」と「フォントの内容領域」の大きい方**——
 * 内容領域が行送りより大きいフォントは、こちらが何もしなくても隣の行へ被る。
 * ここで見たいのは**こちらが足した分がその外へ出ていないか**。
 * 文字のインクは帯の外（対照）と同数であること＝隣の行の字が欠けていない。
 */
const reportBands = (label, r, shotPath) => {
  if (r.error) { check(false, `${label}: ${r.error}`); return; }
  const limit = Math.max(r.pitch, r.content);
  log(`  ${label}: 広い帯 ${r.bands} 本 / 行送り ${r.pitch}px・内容領域 ${r.content}px → 上限 ${limit.toFixed(2)}px / 塗った高さ ${r.paintedMin}〜${r.paintedMax}px`);
  log(`    帯の色（上から）=${r.colors.join(" / ")} 文字色=${r.inkColor}`);
  for (const [where, v] of [["上", r.above], ["下", r.below]]) {
    log(`    ${where}の行の内容領域: 隣の帯の色 内側 ${v.inside.band} / 外側 ${v.outside.band} 画素、文字 内側 ${v.inside.ink} / 外側 ${v.outside.ink} 画素`);
  }
  if (shotPath) log(`  画像: ${shotPath}`);
  check(r.bands === LAYOUT.wideBands, `${label}: 広い帯が ${LAYOUT.wideBands} 本見つかる（実際 ${r.bands} 本）`);
  // **1 CSS px の許容**は縁のアンチエイリアスと、`.a-reverse` が持つ端数の丸め代（+0.5px）の分。
  // ここを 0 にすると丸め代そのものが落ちる——見たいのは「1 画素を超えて隣へ乗っていないか」。
  check(r.paintedMax <= limit + 1, `${label}: 帯の塗りが上下へはみ出していない（${r.paintedMax}px ≦ ${limit.toFixed(2)}px＋1px の許容）`);
  for (const [where, v] of [["上", r.above], ["下", r.below]]) {
    check(v.inside.band === 0, `${label}: ${where}の行の内容領域に隣の帯の色が入っていない（${v.inside.band} 画素）`);
    check(
      v.outside.ink > 0 && v.inside.ink >= v.outside.ink * 0.98,
      `${label}: ${where}の行の文字が帯に食われていない（内側 ${v.inside.ink} / 外側 ${v.outside.ink} 画素）`
    );
  }
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

  log("\n### 1. web-ui の画面（同じ幅の帯＝隙間）");
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
  log("\n### 2. MCP が出す HTML（renderScreenHtml・同じ幅の帯）");
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

  // 画面1 を閉じてコマンド行へ戻す
  for (let i = 0; i < 4; i++) {
    if ((await page.locator(".pane").innerText()).includes("コマンドを入力")) break;
    await page.keyboard.press("Enter");
    await sleep(2200);
  }

  // **画面2: 幅の違う帯**——延ばした背景が上下の行へ被っていないかを見る。
  // web-ui はここでもフォントを差し替えた状態のまま測る（症状が出る側で見たいのは同じ）。
  log("\n### 3. web-ui の画面（幅違いの帯＝はみ出し）");
  await page.keyboard.type(`CALL ${LIB}/REVCL2`);
  await page.keyboard.press("Enter");
  await sleep(3000);
  const bandShot = join(OUT, "reverse-bands-webui.png");
  await page.locator(".pane").screenshot({ path: bandShot });
  check((await page.locator(".pane").innerText()).includes("BAND WIDTHS"), "幅違いの画面が出ている");
  reportBands("web-ui（monospace）", await measureBands(page, ".a-reverse", LAYOUT), bandShot);

  log("\n### 4. MCP が出す HTML（幅違いの帯）");
  const entry2 = sessions.list()[0];
  const html2 = renderScreenHtml(entry2.session.snapshot(), {
    capturedAt: new Date().toISOString(),
    host,
    title: "REVTST2 幅違いの帯"
  });
  const htmlPath2 = join(OUT, "reverse-bands-mcp.html");
  writeFileSync(htmlPath2, html2);
  log(`  出力: ${htmlPath2}（${html2.length} バイト）`);
  const bandPage = await browser.newPage({ viewport: { width: 1200, height: 800 }, deviceScaleFactor: 2 });
  await bandPage.goto("file://" + htmlPath2);
  await bandPage.waitForSelector(".grid", { timeout: 10000 });
  await sleep(400);
  const bandMcpShot = join(OUT, "reverse-bands-mcp.png");
  await bandPage.locator(".crt").screenshot({ path: bandMcpShot });
  check(html2.includes("BAND WIDTHS"), "MCP の HTML に幅違いの画面が入っている");
  reportBands("MCP HTML", await measureBands(bandPage, ".a-r", LAYOUT), bandMcpShot);
  await bandPage.close();

  // 画面2 を閉じてコマンド行へ戻す
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
