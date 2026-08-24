// **VT の背景色（SGR 40-47 / 反転 7）が行間を塗り残さないか**を実画素で確かめる。
//
// 5250 / 3270（`ScreenGrid`）と VT（`VtPane`）は**描画系が別**。5250 側で直した
// 「行間（line-height の余白）は文字要素の背景では塗られない」問題は、VT にもそのまま出る
// ——しかも VT は `vi` / `mc` / `tmux` のように**背景色を面で敷くアプリ**が普通なので、
// 縞が画面いっぱいに出る。
//
// 見るのは 2 つ（`verify-browser-reverse-rows.mjs` と同じ物差し）:
//   1. 背景色の行が縦に続く塊の中に**地色の画素が無い**（隙間）
//   2. 幅の違う帯を交互に置いたとき、**塗った高さが行送りを超えない**（はみ出し）
//
// **実機は使わない。** 検証用の telnet ホスト（`scripts/vt-telnetd`）に繋ぐ——VT の
// サインオン失敗は `QMAXSIGN` に数えられるので、実機で試し撃ちしない。
//
// 準備:
//   docker build -t ts5250-vt-telnetd scripts/vt-telnetd
//   docker run -d --name ts5250-vt -p 2331:23 ts5250-vt-telnetd
//   npm run build && npm run build -w @ts5250/web-ui
// 実行:
//   node scripts/verify-browser-vt-reverse.mjs
// 任意: VT_PORT（既定 2331）/ SHOT_OUT（画像の出力先。既定 /tmp）
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serve } from "@hono/node-server";
import { WebSocketServer } from "ws";
import { buildApp, SessionManager, ServerConfigStore, PersonalConfigStore, ConfigResolver } from "@ts5250/server";
import { chromium } from "playwright";

const PORT = Number(process.env.PORT ?? 3496);
const VT_PORT = Number(process.env.VT_PORT ?? 2331);
const OUT = process.env.SHOT_OUT ?? tmpdir();
const NAME = "VT-LINUX";
const BLOCK_ROWS = 8; // 背景色の行を縦に何行並べるか
const WIDE = 32, NARROW = 12; // 幅違いの帯（はみ出しを見る）

const log = (s) => process.stdout.write(s + "\n");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
const check = (cond, msg) => { if (cond) { pass++; log(`  PASS ${msg}`); } else { fail++; log(`  FAIL ${msg}`); } };

const resolver = new ConfigResolver(
  new ServerConfigStore({
    systems: [{ id: "lx", name: "LINUX", host: "127.0.0.1", port: VT_PORT }],
    sessions: [{ id: "svt", name: NAME, system: "lx", sessionType: "display", terminal: "vt", vtEncoding: "utf-8" }]
  }),
  new PersonalConfigStore()
);
const app = buildApp({ sessions: new SessionManager(), resolver, version: "verify", webRoot: "packages/web-ui/dist" });
const wss = new WebSocketServer({ noServer: true });
const server = serve({ fetch: app.fetch, port: PORT, websocket: { server: wss } });
await sleep(500);

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1200, height: 820 }, deviceScaleFactor: 2 });

/**
 * **背景色の塊を実画素で測る。** 撮った PNG を data URI でブラウザへ戻し、canvas の
 * `getImageData` で読む（Node 側に画像デコーダーを持ち込まない）。
 *
 * VT の run は `.vt-line` の中の span で、背景色は inline style に入る。
 * 測る筋は**空白だけの run の中央**——文字があるとその画素は文字色になり、隙間と紛れる。
 */
async function measure(page, { wide = false } = {}) {
  const shot = await page.locator(".vt-body").screenshot();
  const uri = "data:image/png;base64," + shot.toString("base64");
  return page.evaluate(
    ({ uri, wide, narrowCols }) =>
      new Promise((resolve) => {
        const body = document.querySelector(".vt-body");
        const gr = body.getBoundingClientRect();
        const pitch = parseFloat(getComputedStyle(document.querySelector(".vt-line")).height);
        // 背景色が付いた run（inline style に background があるもの）を集める
        const boxes = [...body.querySelectorAll(".vt-line span")]
          .filter((el) => el.style.background !== "")
          .map((el) => el.getBoundingClientRect())
          .filter((r) => r.width > 4 && r.height > 2)
          .map((r) => ({ left: r.left - gr.left, top: r.top - gr.top, w: r.width, h: r.height }))
          .sort((a, b) => a.top - b.top);
        if (boxes.length < 2) { resolve({ error: `背景色の run が ${boxes.length} 個しか無い` }); return; }

        const img = new Image();
        img.onload = () => {
          const cv = document.createElement("canvas");
          cv.width = img.naturalWidth;
          cv.height = img.naturalHeight;
          const ctx = cv.getContext("2d");
          ctx.drawImage(img, 0, 0);
          const s = img.naturalWidth / gr.width;
          const px = (x, y) => {
            const d = ctx.getImageData(Math.round(x), Math.round(y), 1, 1).data;
            return [d[0], d[1], d[2]];
          };
          const dist = (a, b) => Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) + Math.abs(a[2] - b[2]);
          const m = /rgba?\(([^)]+)\)/.exec(getComputedStyle(body.parentElement).backgroundColor);
          const bg = m ? m[1].split(",").slice(0, 3).map((v) => parseFloat(v)) : [0, 0, 0];

          if (!wide) {
            // 1. 縦に続く塊の中に地色が残らないか
            const x = (boxes[0].left + boxes[0].w / 2) * s;
            const yTop = (boxes[0].top + boxes[0].h / 2) * s;
            const yBottom = (boxes[boxes.length - 1].top + boxes[boxes.length - 1].h / 2) * s;
            const cell = px(x, yTop);
            let gaps = 0, run = 0, maxRun = 0;
            for (let y = yTop; y <= yBottom; y++) {
              if (dist(px(x, y), bg) < dist(px(x, y), cell)) { gaps++; run++; maxRun = Math.max(maxRun, run); }
              else run = 0;
            }
            resolve({ rows: boxes.length, pitch: +pitch.toFixed(2), gaps, maxRun, cell: cell.join(",") });
            return;
          }
          // 2. 幅違い: 広い帯だけが届く桁で塗った高さを測る
          const maxW = Math.max(...boxes.map((b) => b.w));
          const wideBoxes = boxes.filter((b) => Math.abs(b.w - maxW) < 2);
          const charW = wideBoxes[0].w / (narrowCols * 2 + 8); // 幅は下で正規化するので概算
          const x = (wideBoxes[0].left + wideBoxes[0].w - Math.max(2, charW)) * s; // 右端寄り＝狭い帯が届かない桁
          const painted = wideBoxes.map((b) => {
            const yc = (b.top + b.h / 2) * s;
            const cell = px(x, yc);
            let up = 0, down = 0;
            while (dist(px(x, yc - up - 1), cell) < 30 && up < pitch * s * 3) up++;
            while (dist(px(x, yc + down + 1), cell) < 30 && down < pitch * s * 3) down++;
            return (up + down + 1) / s;
          });
          resolve({
            bands: wideBoxes.length,
            pitch: +pitch.toFixed(2),
            content: +wideBoxes[0].h.toFixed(2),
            paintedMax: +Math.max(...painted).toFixed(2),
            paintedMin: +Math.min(...painted).toFixed(2)
          });
        };
        img.onerror = () => resolve({ error: "撮った画像を読み込めない" });
        img.src = uri;
      }),
    { uri, wide, narrowCols: NARROW }
  );
}

const type = async (text, wait = 500) => {
  await page.locator(".vt-pane").focus();
  await page.keyboard.type(text);
  await sleep(wait);
  await page.keyboard.press("Enter");
  await sleep(wait + 400);
};

try {
  await page.goto(`http://localhost:${PORT}/`);
  await page.locator(".card", { hasText: NAME }).first().locator("button", { hasText: "接続" }).click();
  await page.waitForSelector(".vt-pane", { timeout: 20000 });
  await sleep(1500);
  check((await page.locator(".vt-pane").count()) === 1, "VT のペインが出る");
  await type("export PS1=''; stty -echo; clear");

  // --- 1. 背景色の行を縦に並べる（隙間） ---
  log("\n### 1. 背景色が縦に続く（隙間）");
  await type(`clear; for i in $(seq ${BLOCK_ROWS}); do printf '\\033[42m%-${WIDE}s\\033[0m\\n' ' '; done`, 900);
  const rowsShot = join(OUT, "vt-reverse-rows.png");
  await page.locator(".vt-pane").screenshot({ path: rowsShot });
  const r1 = await measure(page);
  if (r1.error) check(false, `隙間の測定: ${r1.error}`);
  else {
    log(`  背景色の run ${r1.rows} 行 / 行送り ${r1.pitch}px / 地色の画素 ${r1.gaps}（最長 ${r1.maxRun} 連続） 背景色=${r1.cell}`);
    log(`  画像: ${rowsShot}`);
    check(r1.rows >= BLOCK_ROWS, `背景色の行が ${BLOCK_ROWS} 行以上見つかる（実際 ${r1.rows} 行）`);
    check(r1.gaps === 0, `塊の中に地色の画素が無い（実際 ${r1.gaps} 画素）`);
  }

  // --- 2. 幅の違う帯（はみ出し） ---
  log("\n### 2. 幅の違う帯（はみ出し）");
  await type(
    `clear; for i in 1 2 3 4; do printf '\\033[44m%-${WIDE}s\\033[0m\\n' ' '; printf '\\033[44m%-${NARROW}s\\033[0m\\n' ' '; done`,
    900
  );
  const bandShot = join(OUT, "vt-reverse-bands.png");
  await page.locator(".vt-pane").screenshot({ path: bandShot });
  const r2 = await measure(page, { wide: true });
  if (r2.error) check(false, `はみ出しの測定: ${r2.error}`);
  else {
    const limit = Math.max(r2.pitch, r2.content);
    log(`  広い帯 ${r2.bands} 本 / 行送り ${r2.pitch}px・run の高さ ${r2.content}px → 上限 ${limit.toFixed(2)}px / 塗った高さ ${r2.paintedMin}〜${r2.paintedMax}px`);
    log(`  画像: ${bandShot}`);
    check(r2.bands >= 4, `広い帯が 4 本以上見つかる（実際 ${r2.bands} 本）`);
    // 1 CSS px は縁のアンチエイリアス分の許容
    check(r2.paintedMax <= limit + 1, `帯の塗りが上下へはみ出していない（${r2.paintedMax}px ≦ ${limit.toFixed(2)}px＋1px の許容）`);
  }

  // --- 3. 桁がずれていないこと（箱にしたことで padding の扱いが変わらないか） ---
  log("\n### 3. 桁の整列（箱にしても桁がずれない）");
  await type("clear; printf '0123456789\\n\\033[42m0123456789\\033[0m\\n'", 900);
  const cols = await page.evaluate(() => {
    const lines = [...document.querySelectorAll(".vt-line")].filter((l) => l.textContent.includes("0123456789"));
    if (lines.length < 2) return { error: `見本の行が ${lines.length} 行しか無い` };
    const rect = (el) => el.getBoundingClientRect();
    return { plain: +rect(lines[0].querySelector("span")).left.toFixed(2), colored: +rect(lines[1].querySelector("span")).left.toFixed(2) };
  });
  if (cols.error) check(false, `桁の整列: ${cols.error}`);
  else {
    log(`  素の行 left=${cols.plain}px / 背景色の行 left=${cols.colored}px`);
    check(Math.abs(cols.plain - cols.colored) < 0.5, "背景色の有無で桁がずれない");
  }
} catch (err) {
  check(false, err instanceof Error ? err.message : String(err));
} finally {
  await browser.close();
  await new Promise((r) => server.close(r));
}

log(`\n${fail === 0 ? "すべて PASS" : `FAIL ${fail} 件`}（PASS ${pass}）`);
process.exit(fail === 0 ? 0 : 1);
