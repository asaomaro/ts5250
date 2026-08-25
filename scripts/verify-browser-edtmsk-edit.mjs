// **EDTMSK で分割された欄（`9999/99/99`）を ACS と同じ「1 つの欄」として扱えているか**を実機で見る。
//
// ホストは EDTMSK で割った数値欄を、区切り文字（`/`）を挟んだ**複数の別々の欄**として送る
// （`Field.continued` = first/middle/last）。ACS はこれをまるごと 1 つの入力欄として見せる:
//   ① 色は区切りの桁でも途切れない（区切りは前の区間の色を引き継ぐ）
//   ② 下線は区切りの桁でも 1 本に繋がる
//   ③ Backspace / Delete は区切りをまたいで詰め直す
//   ④ `2026/08/25` のように区切りを含めてペーストしても桁がずれない
//
// 検証資材は scripts/build-dttest.mjs が作る <LIB>/DTMDSPF ＋ DTMPGM の **`D8U`**
// （8 桁 EDTWRD+EDTMSK ＋ `COLOR(WHT)` ＋ `DSPATR(UL)`。素の欄では色も下線も差が出ない）。
//
// 実行:
//   npm run build && npm run build -w @ts5250/web-ui
//   node --env-file=.env --env-file=.env.verify scripts/verify-browser-edtmsk-edit.mjs
// 任意: SHOT_OUT（画像の出力先。既定 /tmp）/ MSK_ROW（D8U の行。既定 23）
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serve } from "@hono/node-server";
import { WebSocketServer } from "ws";
import { buildApp, SessionManager, ServerConfigStore, PersonalConfigStore, ConfigResolver } from "@ts5250/server";
import { SecretCrypto } from "../packages/server/dist/secret-crypto.js";
import { chromium } from "playwright";

const host = process.env.AS400_HOST;
const user = process.env.AS400_USER;
if (!host || !user || !process.env.AS400_PASSWORD) {
  process.stderr.write("AS400_HOST / AS400_USER / AS400_PASSWORD を環境変数で渡してください\n");
  process.exit(2);
}
const LIB = process.env.AS400_LIB ?? "TESTLIB";
const OUT = process.env.SHOT_OUT ?? tmpdir();
const PORT = Number(process.env.PORT ?? 3500);
const ROW = Number(process.env.MSK_ROW ?? 23); // D8U の行（build-dttest.mjs の CASES と揃える）
const COL = 24; // 欄の開始桁
// 区間: 4 桁 + `/` + 2 桁 + `/` + 2 桁
const SEG = [COL, COL + 5, COL + 8];
const SEPCOL = [COL + 4, COL + 7];

const log = (s) => process.stdout.write(s + "\n");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
const check = (cond, msg) => { if (cond) { pass++; log(`  PASS ${msg}`); } else { fail++; log(`  FAIL ${msg}`); } };

const work = mkdtempSync(join(tmpdir(), "edtmsk-"));
const cfgPath = join(work, "profiles.json");
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
const app = buildApp({ sessions: new SessionManager(), resolver, version: "verify", webRoot: "packages/web-ui/dist" });
const wss = new WebSocketServer({ noServer: true });
const server = serve({ fetch: app.fetch, port: PORT, websocket: { server: wss } });
await sleep(600);

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1400, height: 900 }, deviceScaleFactor: 2 });
await page.context().grantPermissions(["clipboard-read", "clipboard-write"], { origin: `http://localhost:${PORT}` });

const sel = (col) => `input.grid-input[data-field="f${ROW}c${col}"]`;
const segValues = async () => Promise.all(SEG.map(async (c) => (await page.locator(sel(c)).inputValue()).replace(/\s+$/, "")));
const shown = async () => (await segValues()).join("/");
async function focusSeg(i, caret = 0) {
  const el = page.locator(sel(SEG[i]));
  await el.click();
  await el.evaluate((e, k) => e.setSelectionRange(k, k), caret);
  await sleep(120);
}
/** 行 ROW の桁 col にある**入力欄でないセル**（区切り文字）の情報 */
const sepInfo = (col) =>
  page.evaluate(
    ({ row, col }) => {
      const line = [...document.querySelectorAll(".grid-row")][row - 1];
      if (!line) return undefined;
      // 行の中を桁で数えて、その桁を含む span を探す（input は 1 要素で複数桁を占める）
      let c = 1;
      for (const el of line.children) {
        const isInput = el.classList.contains("input-cell") || el.tagName === "INPUT";
        const inputEl = el.tagName === "INPUT" ? el : el.querySelector("input");
        const width = inputEl ? Number(inputEl.getAttribute("maxlength") ?? 1) : (el.textContent ?? "").length;
        if (col >= c && col < c + width) {
          const cs = getComputedStyle(el);
          const r = el.getBoundingClientRect();
          return {
            text: el.textContent ?? "",
            cls: [...el.classList].join(" "),
            isInput,
            borderBottom: cs.borderBottomWidth,
            textDecoration: cs.textDecorationLine,
            bottom: Math.round(r.bottom * 10) / 10,
            color: cs.color
          };
        }
        c += width;
      }
      return undefined;
    },
    { row: ROW, col }
  );
const inputInfo = (col) =>
  page.evaluate((s) => {
    const el = document.querySelector(s);
    if (!el) return undefined;
    const cs = getComputedStyle(el);
    const r = el.getBoundingClientRect();
    return { cls: [...el.classList].join(" "), borderBottom: cs.borderBottomWidth, bottom: Math.round(r.bottom * 10) / 10, color: cs.color };
  }, sel(col));

try {
  await page.goto(`http://localhost:${PORT}/`);
  await page.waitForSelector(".launcher", { timeout: 20000 });
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

  await page.keyboard.type(`CALL ${LIB}/DTMPGM`);
  await page.keyboard.press("Enter");
  await sleep(3000);
  check((await page.locator(".pane").innerText()).includes("DATE / TIME MASK TEST"), "DTMPGM のテスト画面が出ている");
  check((await page.locator(sel(SEG[0])).count()) === 1, `D8U の欄が行 ${ROW} 桁 ${COL} にある`);

  // --- ① 区切りの色が途切れない ---
  log("\n### ① 区切り文字の色");
  const sep0 = await sepInfo(SEPCOL[0]);
  const in0 = await inputInfo(SEG[0]);
  log(`  区切り: text=${JSON.stringify(sep0?.text)} class=${JSON.stringify(sep0?.cls)} color=${sep0?.color}`);
  log(`  入力欄: class=${JSON.stringify(in0?.cls)} color=${in0?.color}`);
  check(sep0?.text?.includes("/") === true, "区切りの `/` が画面に出ている");
  check(sep0?.color === in0?.color, `区切りの色が入力欄と同じ（実際 ${sep0?.color} / ${in0?.color}）`);

  // --- ② 区切りの下線が繋がる ---
  log("\n### ② 区切り文字の下線");
  log(`  区切り: border-bottom=${sep0?.borderBottom} text-decoration=${sep0?.textDecoration} 下端=${sep0?.bottom}`);
  log(`  入力欄: border-bottom=${in0?.borderBottom} 下端=${in0?.bottom}`);
  check(parseFloat(sep0?.borderBottom ?? "0") > 0, `区切りの下線が border-bottom で引かれている（実際 ${sep0?.borderBottom}）`);
  check(
    Math.abs((sep0?.bottom ?? 0) - (in0?.bottom ?? 0)) <= 1,
    `下線の高さが入力欄と揃う（実際 ${sep0?.bottom} / ${in0?.bottom}）`
  );

  // --- ③ Backspace / Delete が区間をまたぐ ---
  log("\n### ③ 区間をまたぐ Backspace / Delete");
  await focusSeg(0);
  await page.keyboard.type("20260825", { delay: 40 });
  await sleep(300);
  log(`  8 桁打った直後: ${await shown()}`);
  check((await shown()) === "2026/08/25", `8 桁が全区間へ入る（実際 ${await shown()}）`);

  // **最終区間の末尾へ明示的に置く。** 8 桁打ち終えると自動送りで次の欄へ出てしまうので、
  // ここで置き直さないと Backspace が別の欄に効く（この検証自体が空振りする）。
  await focusSeg(2, 2);
  for (let i = 0; i < 3; i++) { await page.keyboard.press("Backspace"); await sleep(150); }
  const afterBs = await segValues();
  log(`  末尾から Backspace ×3: ${afterBs.map((v) => JSON.stringify(v)).join(" ")}`);
  check(afterBs.join("") === "20260", `区間をまたいで詰まる（期待 "2026"/"0"/"" 実際 ${JSON.stringify(afterBs)}）`);

  await focusSeg(0, 0);
  await page.keyboard.press("Delete");
  await sleep(200);
  const afterDel = await segValues();
  log(`  先頭で Delete ×1: ${afterDel.map((v) => JSON.stringify(v)).join(" ")}`);
  check(afterDel.join("") === "0260", `Delete も区間をまたいで詰まる（実際 ${JSON.stringify(afterDel)}）`);

  // --- ④ 区切りを含むペースト ---
  log("\n### ④ 区切りを含む文字列のペースト");
  await page.evaluate(() => navigator.clipboard.writeText("2026/08/25"));
  await focusSeg(0, 0);
  await page.keyboard.press("Control+v");
  await sleep(400);
  const afterPaste = await shown();
  log(`  "2026/08/25" をペースト: ${afterPaste}`);
  check(afterPaste === "2026/08/25", `区切り込みでも桁がずれない（実際 ${afterPaste}）`);

  const shot = join(OUT, "edtmsk-edit.png");
  await page.locator(".pane").screenshot({ path: shot });
  log(`  画像: ${shot}`);
  await page.keyboard.press("F3");
  await sleep(1500);
} catch (err) {
  check(false, err instanceof Error ? err.message : String(err));
} finally {
  await browser.close();
  await new Promise((r) => server.close(r));
  rmSync(work, { recursive: true, force: true });
}

log(`\n${fail === 0 ? "すべて PASS" : `FAIL ${fail} 件`}（PASS ${pass}）`);
process.exit(fail === 0 ? 0 : 1);
