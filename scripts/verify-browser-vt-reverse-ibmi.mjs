// **pub400（実 IBM i）の VT で、背景色（DSPATR(RI) → SGR 7）が行間を塗り残さないか**を実画素で確かめる。
// 物差しは `scripts/verify-browser-vt-reverse.mjs`（docker の telnetd 相手）と同じ。
//
// **なぜ実機版も要るか。** VT の翻訳（5250 → ASCII）はホストがやる。docker の Linux で作った
// 背景色と、IBM i が `DSPATR(RI)` を SGR 7 に翻訳して送ってくる背景色は**出どころが別**なので、
// 実機で 1 度は見ておく（実測: IBM i の VT は色を落とし、reverse だけを送ってくる）。
//
// docker 版と違うのは 2 点:
//   - 画面は `<LIB>/REVCL`（同幅の反転 8 行）と `REVCL2`（広狭の帯）を CALL して出す
//     （`scripts/build-revtest.mjs` を pub400 に向けて流すと作れる）
//   - 履歴（scrollback）が積もるので、**測る枠は `.vt-body` ではなく `.vt-pane`（見えている範囲）**
//
// 修正前との比較は **dist を作り直さず**、`.vt-line span` の display/height/vertical-align を
// `page.addStyleTag` で一時的に解除して同じセッションのまま撮る。
//
// ⚠ **サインオンの失敗は QMAXSIGN（pub400 は 5）に数えられる。** 試行を重ねないこと。
//
// 実行:
//   npm run build && npm run build -w @ts5250/web-ui
//   node --env-file=.env --env-file=.env.verify scripts/verify-browser-vt-reverse-ibmi.mjs
// 任意: SHOT_OUT（画像の出力先。既定 /tmp）
import { join } from "node:path";
import { serve } from "@hono/node-server";
import { WebSocketServer } from "ws";
import { buildApp, SessionManager, ServerConfigStore, PersonalConfigStore, ConfigResolver } from "@ts5250/server";
import { SecretCrypto } from "../packages/server/dist/secret-crypto.js";
import { chromium } from "playwright";

const PORT = Number(process.env.PORT ?? 3497);
const OUT = process.env.SHOT_OUT ?? "/tmp";
const LIB = process.env.PUB400_LIB ?? "TESTLIB";
const NAME = "VT-PUB400";
const log = (s) => process.stdout.write(s + "\n");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
const check = (cond, msg) => { if (cond) { pass++; log(`  PASS ${msg}`); } else { fail++; log(`  FAIL ${msg}`); } };

const crypto = SecretCrypto.fromEnv();
if (!crypto) { log("AS400_SECRET_KEY が要ります（.env）"); process.exit(1); }
const host = process.env.PUB400_HOST, user = process.env.PUB400_USER, password = process.env.PUB400_PASSWORD;
if (!host || !user || !password) { log("PUB400_HOST / _USER / _PASSWORD が要ります"); process.exit(2); }

const resolver = new ConfigResolver(
  new ServerConfigStore(
    {
      // CCSID 37 を持たせる＝NEW-ENVIRON の KBDTYPE/CODEPAGE/CHARSET。無申告だと CPF1120
      systems: [{ id: "i", name: "PUB400", host, ccsid: 37 }],
      sessions: [{ id: "svt", name: NAME, system: "i", sessionType: "display", terminal: "vt", vtEncoding: "utf-8" }]
    },
    crypto
  ),
  new PersonalConfigStore()
);
const app = buildApp({ sessions: new SessionManager(), resolver, version: "verify", webRoot: "packages/web-ui/dist" });
const wss = new WebSocketServer({ noServer: true });
const server = serve({ fetch: app.fetch, port: PORT, websocket: { server: wss } });
await sleep(500);

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1100, height: 800 }, deviceScaleFactor: 2 });
const paneText = () => page.locator(".vt-pane").innerText();

/**
 * **背景色の塊を実画素で測る。** 撮った PNG を data URI でブラウザへ戻し canvas の
 * `getImageData` で読む（Node 側に画像デコーダーを持ち込まない）。
 * 枠は `.vt-pane`（見えている範囲）——履歴に前の画面の反転が残っていても拾わない。
 */
async function measure(page, { wide = false } = {}) {
  const shot = await page.locator(".vt-pane").screenshot();
  const uri = "data:image/png;base64," + shot.toString("base64");
  return page.evaluate(
    ({ uri, wide }) =>
      new Promise((resolve) => {
        const pane = document.querySelector(".vt-pane");
        const gr = pane.getBoundingClientRect();
        const pitch = parseFloat(getComputedStyle(document.querySelector(".vt-line")).height);
        const boxes = [...pane.querySelectorAll(".vt-line span")]
          .filter((el) => el.style.background !== "")
          .map((el) => el.getBoundingClientRect())
          .filter((r) => r.width > 4 && r.height > 2)
          // **見えている範囲だけ**（履歴に流れた前の画面を拾わない）
          .filter((r) => r.top >= gr.top && r.bottom <= gr.bottom)
          .map((r) => ({ left: r.left - gr.left, top: r.top - gr.top, w: r.width, h: r.height }))
          .sort((a, b) => a.top - b.top);
        if (boxes.length < 2) { resolve({ error: `背景色の run が ${boxes.length} 個しか無い` }); return; }

        const img = new Image();
        img.onload = () => {
          const cv = document.createElement("canvas");
          cv.width = img.naturalWidth; cv.height = img.naturalHeight;
          const ctx = cv.getContext("2d");
          ctx.drawImage(img, 0, 0);
          const s = img.naturalWidth / gr.width;
          const px = (x, y) => { const d = ctx.getImageData(Math.round(x), Math.round(y), 1, 1).data; return [d[0], d[1], d[2]]; };
          const dist = (a, b) => Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) + Math.abs(a[2] - b[2]);
          const m = /rgba?\(([^)]+)\)/.exec(getComputedStyle(pane).backgroundColor);
          const bg = m ? m[1].split(",").slice(0, 3).map((v) => parseFloat(v)) : [0, 0, 0];

          if (!wide) {
            // **同じ幅・同じ桁で縦に続く塊**だけを取り出す（画面には別の塊も居る）
            const key = (b) => `${Math.round(b.left)}:${Math.round(b.w)}`;
            const groups = new Map();
            for (const b of boxes) { const k = key(b); if (!groups.has(k)) groups.set(k, []); groups.get(k).push(b); }
            let chain = [];
            for (const g of groups.values()) {
              let cur = [g[0]];
              for (let i = 1; i < g.length; i++) {
                if (g[i].top - g[i - 1].top < pitch * 1.6) cur.push(g[i]);
                else { if (cur.length > chain.length) chain = cur; cur = [g[i]]; }
              }
              if (cur.length > chain.length) chain = cur;
            }
            if (chain.length < 2) { resolve({ error: "縦に続く塊が見つからない" }); return; }
            const x = (chain[0].left + chain[0].w / 2) * s;
            const yTop = (chain[0].top + chain[0].h / 2) * s;
            const yBottom = (chain[chain.length - 1].top + chain[chain.length - 1].h / 2) * s;
            const cell = px(x, yTop);
            let gaps = 0, run = 0, maxRun = 0;
            for (let y = yTop; y <= yBottom; y++) {
              if (dist(px(x, y), bg) < dist(px(x, y), cell)) { gaps++; run++; maxRun = Math.max(maxRun, run); }
              else run = 0;
            }
            resolve({ rows: chain.length, pitch: +pitch.toFixed(2), content: +chain[0].h.toFixed(2),
              gaps, maxRun, cell: cell.join(","), bg: bg.join(","), scale: s, span: +((yBottom - yTop) / s).toFixed(2) });
            return;
          }
          // 幅違い: **広い帯だけが届く桁**で塗った高さを測る（上下は地色しか無い）
          const maxW = Math.max(...boxes.map((b) => b.w));
          const wideBoxes = boxes.filter((b) => Math.abs(b.w - maxW) < 2);
          const x = (wideBoxes[0].left + wideBoxes[0].w - 3) * s;
          const painted = wideBoxes.map((b) => {
            const yc = (b.top + b.h / 2) * s;
            const cell = px(x, yc);
            let up = 0, down = 0;
            while (dist(px(x, yc - up - 1), cell) < 30 && up < pitch * s * 3) up++;
            while (dist(px(x, yc + down + 1), cell) < 30 && down < pitch * s * 3) down++;
            return (up + down + 1) / s;
          });
          resolve({ bands: wideBoxes.length, pitch: +pitch.toFixed(2), content: +wideBoxes[0].h.toFixed(2),
            paintedMax: +Math.max(...painted).toFixed(2), paintedMin: +Math.min(...painted).toFixed(2) });
        };
        img.onerror = () => resolve({ error: "撮った画像を読み込めない" });
        img.src = uri;
      }),
    { uri, wide }
  );
}

/** 修正前相当（`.vt-line span` を素のインラインに戻す）。同じセッションのまま比べる */
const BEFORE_CSS = `.vt-line span { display: inline !important; height: auto !important; vertical-align: baseline !important; }`;

const cmd = async (text, wait = 9000) => {
  await page.locator(".vt-pane").focus();
  await page.keyboard.type(text, { delay: 40 });
  await sleep(600);
  await page.keyboard.press("Enter");
  await sleep(wait);
};

try {
  await page.goto(`http://localhost:${PORT}/`);
  await page.locator(".card", { hasText: NAME }).first().locator("button", { hasText: "接続" }).click();
  await page.waitForSelector(".vt-pane", { timeout: 25000 });
  await sleep(6000);
  const signon = await paneText();
  check(/user name|Sign On|User/iu.test(signon), "サインオン画面が届く");

  log("\n[サインオン（**失敗は QMAXSIGN に数えられる**ので 1 回だけ）]");
  await page.locator(".vt-pane").focus();
  await page.keyboard.type(user, { delay: 40 });
  await sleep(600);
  await page.keyboard.press("Tab");
  await sleep(1000);
  await page.keyboard.type(password, { delay: 40 });
  await sleep(600);
  await page.keyboard.press("Enter");
  await sleep(10000);
  let after = await paneText();
  if (/Press Enter|継続するには/iu.test(after)) { await page.keyboard.press("Enter"); await sleep(5000); after = await paneText(); }
  check(!/CPF1120/u.test(after), "CPF1120 が出ない");
  check(/Main Menu|MAIN/u.test(after), "IBM i のメインメニューに到達した");

  // ---- 1. 反転が縦に 8 行続く（行間の隙間） ----
  log(`\n### 1. 反転が縦に続く（隙間）— CALL ${LIB}/REVCL`);
  await cmd(`CALL ${LIB}/REVCL`);
  check(/BLOCKS MUST HAVE NO GAPS/u.test(await paneText()), "REVCL の画面が出た");
  await page.locator(".vt-pane").screenshot({ path: join(OUT, "pub400-vt-rows-after.png") });
  const r1 = await measure(page);
  if (r1.error) check(false, `隙間の測定: ${r1.error}`);
  else {
    log(`  修正後: 反転 ${r1.rows} 行 / 行送り ${r1.pitch}px・run の高さ ${r1.content}px / 塊の縦幅 ${r1.span}px`);
    log(`          地色の画素 ${r1.gaps}（最長 ${r1.maxRun} 連続） 反転色=${r1.cell} 地色=${r1.bg} 倍率=${r1.scale}`);
    check(r1.rows >= 8, `反転の行が 8 行以上見つかる（実際 ${r1.rows} 行）`);
    check(r1.gaps === 0, `塊の中に地色の画素が無い（実際 ${r1.gaps} 画素）`);
  }
  // 修正前相当
  const tag1 = await page.addStyleTag({ content: BEFORE_CSS });
  await sleep(400);
  await page.locator(".vt-pane").screenshot({ path: join(OUT, "pub400-vt-rows-before.png") });
  const r1b = await measure(page);
  await tag1.evaluate((el) => el.remove());
  await sleep(300);
  if (r1b.error) log(`  修正前相当の測定: ${r1b.error}`);
  else {
    log(`  修正前相当: 反転 ${r1b.rows} 行 / 行送り ${r1b.pitch}px・run の高さ ${r1b.content}px`);
    log(`              地色の画素 ${r1b.gaps}（最長 ${r1b.maxRun} 連続）`);
    check(r1b.gaps > 0, `修正を外すと地色が現れる＝この画面で症状が再現する（実際 ${r1b.gaps} 画素）`);
  }
  await page.keyboard.press("Enter");
  await sleep(7000);

  // ---- 2. 幅違いの帯（はみ出し） ----
  log(`\n### 2. 幅の違う帯（はみ出し）— CALL ${LIB}/REVCL2`);
  await cmd(`CALL ${LIB}/REVCL2`);
  check(/BAND WIDTHS/u.test(await paneText()), "REVCL2 の画面が出た");
  await page.locator(".vt-pane").screenshot({ path: join(OUT, "pub400-vt-bands-after.png") });
  const r2 = await measure(page, { wide: true });
  if (r2.error) check(false, `はみ出しの測定: ${r2.error}`);
  else {
    const limit = Math.max(r2.pitch, r2.content);
    log(`  広い帯 ${r2.bands} 本 / 行送り ${r2.pitch}px・run の高さ ${r2.content}px → 上限 ${limit.toFixed(2)}px`);
    log(`  塗った高さ ${r2.paintedMin}〜${r2.paintedMax}px`);
    check(r2.bands >= 4, `広い帯が 4 本以上見つかる（実際 ${r2.bands} 本）`);
    check(r2.paintedMax <= limit + 1, `帯の塗りが上下へはみ出していない（${r2.paintedMax}px ≦ ${limit.toFixed(2)}px＋1px）`);
  }
  const tag2 = await page.addStyleTag({ content: BEFORE_CSS });
  await sleep(400);
  await page.locator(".vt-pane").screenshot({ path: join(OUT, "pub400-vt-bands-before.png") });
  const r2b = await measure(page, { wide: true });
  await tag2.evaluate((el) => el.remove());
  if (!r2b.error) log(`  修正前相当: 塗った高さ ${r2b.paintedMin}〜${r2b.paintedMax}px（行送り ${r2b.pitch}px・run の高さ ${r2b.content}px）`);
  await page.keyboard.press("Enter");
  await sleep(7000);

  // 桁の整列（背景色の有無で桁がずれない）は docker 版の項目 3 が見ている——
  // こちらは実機の画面が相手で見本の拾い方が安定しないため置かない。

  log("\n[サインオフ]");
  await page.keyboard.type("SIGNOFF", { delay: 40 });
  await page.keyboard.press("Enter");
  await sleep(4000);
} catch (err) {
  check(false, err instanceof Error ? err.message : String(err));
  await page.locator(".vt-pane").screenshot({ path: join(OUT, "pub400-vt-fail.png") }).catch(() => {});
} finally {
  await browser.close();
  await new Promise((r) => server.close(r));
}
log(`\n${fail === 0 ? "すべて PASS" : `FAIL ${fail} 件`}（PASS ${pass}）`);
process.exit(fail === 0 ? 0 : 1);
