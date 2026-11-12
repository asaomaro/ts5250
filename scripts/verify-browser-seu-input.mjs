// SEU 相当の色付き入力行を実ブラウザで検証する（ホスト接続は不要）。
// 実行: node scripts/verify-browser-seu-input.mjs
// ブラウザ指定: SEU_CHECK_BROWSER=/usr/bin/google-chrome node scripts/verify-browser-seu-input.mjs
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { chromium } from "playwright";

const root = fileURLToPath(new URL("../packages/web-ui", import.meta.url));
const fixture = `
import { createApp, h, reactive, ref, nextTick } from 'vue';
import ScreenGrid from '/src/components/ScreenGrid.vue';
import { rawSentinel } from '@ts5250/tn5250/browser';
import '/src/styles.css';
const edits = reactive(new Map());
const snapshot = ref();
function reset(dbcs = false, underline = false) {
  edits.clear();
  const cell = (char = ' ', color = 'green', kind = 'sbcs') => ({char, color, kind, underline, reverse:false, blink:false, columnSeparator:false, nonDisplay:false});
  const cells = Array.from({length:24}, () => Array.from({length:80}, () => cell()));
  const fields = [6,7,8].map((row, i) => {
    [...'HHHH HH'].forEach((char, col) => { cells[row-1][9+col] = cell(char, col < 4 ? 'green' : 'red', col === 4 ? 'attr' : 'sbcs'); });
    return {index:i+1, row, col:10, length:20, protected:false, hidden:false, numeric:false, mdt:false,
      value:dbcs ? 'HHHH HH' : 'HHHH'+rawSentinel(0x28)+'HH', ...(dbcs ? {dbcsType:'open'} : {})};
  });
  snapshot.value = {sessionId:'test', rows:24, cols:80, cursor:{row:1,col:1}, keyboardLocked:false, cells, fields};
  return nextTick();
}
reset();
createApp({setup:() => () => h(ScreenGrid, {snapshot:snapshot.value, edits, focused:false, onEdit:(index,value) => edits.set(index,value)})}).mount('#app');
window.seuCheck = {reset};
`;

let browser;
let server;
try {
  server = await createServer({
    root,
    logLevel: "error",
    server: { host: "127.0.0.1", port: 0 },
    plugins: [{
      name: "seu-input-fixture",
      resolveId: (id) => id === "/__seu-fixture.js" ? id : undefined,
      load: (id) => id === "/__seu-fixture.js" ? fixture : undefined,
      configureServer(vite) {
        vite.middlewares.use("/__seu-check.html", async (_req, res) => {
          res.setHeader("Content-Type", "text/html");
          res.end(await vite.transformIndexHtml("/__seu-check.html", '<div id="app"></div><script type="module" src="/__seu-fixture.js"></script>'));
        });
      }
    }]
  });
  await server.listen();
  const address = server.httpServer.address();
  assert(address && typeof address === "object");
  browser = await chromium.launch({
    ...(process.env.SEU_CHECK_BROWSER ? { executablePath: process.env.SEU_CHECK_BROWSER } : {})
  });
  const page = await browser.newPage({ viewport: { width: 1200, height: 800 }, deviceScaleFactor: 2 });
  const errors = [];
  page.on("pageerror", (err) => errors.push(err.message));
  await page.goto(`http://127.0.0.1:${address.port}/__seu-check.html`);
  await page.locator(".input-overlay").first().waitFor();
  await page.addStyleTag({ content: `
    .grid { --t-glow:0; --crt:#000; }
    .grid-input { caret-color:transparent!important; }
    .grid-input:focus { background:transparent!important; }
    .cursor { display:none!important; }
  ` });
  // フォーカスで Vue が inline style を書き戻しても、比較中のフォントは変えない。
  await page.addStyleTag({ content: "/* comparison font */" }).then((style) => style.evaluate((el) => { el.id = "check-font"; }));
  const settle = () => page.evaluate(async () => {
    await document.fonts.ready;
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  });
  /** 入力欄の文字も Range では測れないため、同じ領域の画素から字形の上端を取る。 */
  async function glyphTop(clip) {
    const png = await page.screenshot({ clip });
    return page.evaluate(async (bytes) => {
      const bitmap = await createImageBitmap(new Blob([new Uint8Array(bytes)], {type:"image/png"}));
      const canvas = document.createElement("canvas");
      canvas.width = bitmap.width; canvas.height = bitmap.height;
      const context = canvas.getContext("2d");
      context.drawImage(bitmap, 0, 0);
      bitmap.close();
      const { data } = context.getImageData(0, 0, canvas.width, canvas.height);
      for (let y = 0; y < canvas.height; y++) {
        let count = 0;
        for (let x = 0; x < canvas.width; x++) {
          const at = (y * canvas.width + x) * 4;
          if (data[at+1] > 100 && data[at+1] > data[at]*1.5 && data[at+1] > data[at+2]*1.5) count++;
        }
        if (count >= 3) return y;
      }
      throw new Error("比較する文字が描画されていません");
    }, [...png]);
  }
  let cases = 0;
  // 再ロードやホストの再描画で結果を作らず、同じ文字の focus/blur だけを比較する。
  for (const family of ["monospace", "Noto Sans Mono CJK JP", "Liberation Mono"]) {
    for (const size of [12, 14, 15, 15.5, 16, 19.2]) {
      for (const underline of [false, true]) {
        await page.evaluate(({family,size,underline}) => {
          document.querySelector("#check-font").textContent = `.grid{font-family:"${family}"!important;font-size:${size}px!important}`;
          return window.seuCheck.reset(false, underline);
        }, { family, size, underline });
        await settle();
        const input = page.locator(".grid-input").first();
        const box = await input.boundingBox();
        const clip = {x:Math.floor(box.x), y:Math.floor(box.y)-3, width:Math.floor(box.width/20*3), height:Math.ceil(box.height)+6};
        for (let repeat = 0; repeat < 2; repeat++) {
          await input.evaluate((el) => el.blur());
          await settle();
          const resting = await glyphTop(clip);
          await input.focus();
          await settle();
          const editing = await glyphTop(clip);
          assert.equal(editing, resting, `文字位置: ${family} ${size}px underline=${underline}`);
        }
        const heights = await input.evaluate((el) => ({input:el.getBoundingClientRect().height, row:el.closest(".grid-row").getBoundingClientRect().height}));
        assert(heights.input <= heights.row, "入力欄が隣の行にはみ出しています");
        cases++;
      }
    }
  }
  for (const dbcs of [false, true]) {
    await page.evaluate((dbcs) => window.seuCheck.reset(dbcs), dbcs);
    await settle();
    const input = page.locator(".grid-input").first();
    await input.focus();
    await input.evaluate((el) => {
      el.setSelectionRange(0, 0);
      const data = new DataTransfer();
      data.setData("text/plain", "AAA\nBBB\nCCC");
      el.dispatchEvent(new ClipboardEvent("paste", {bubbles:true, cancelable:true, clipboardData:data}));
    });
    await settle();
    const words = ["AAA", "BBB", "CCC"];
    assert.deepEqual(await page.locator(".grid-input").evaluateAll((els) => els.map((el) => el.value.slice(0,3))), words);
    assert.equal(await input.evaluate((el) => el.selectionStart), 0, "ペースト開始位置からカーソルが移動しています");
    assert.deepEqual(await page.locator(".input-overlay").allTextContents().then((texts) => texts.map((s) => s.slice(0,3))), words);
    for (const overlay of await page.locator(".input-overlay").all().then((els) => els.slice(1))) assert(await overlay.isVisible());
  }
  assert.deepEqual(errors, []);
  process.stderr.write(`PASS: ${cases} font/size/underline cases × 2 focus cycles; SEU rectangle paste (SBCS/DBCS)\n`);
} finally {
  await browser?.close();
  await server?.close();
}
