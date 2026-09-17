// **ACS の「表示」設定（カーソル・罫線・ポインター・桁区切り）が実ブラウザで効くか**を測る。
//
// jsdom は scoped CSS を計算せず、画素も持たないので、単体テスト
// （`packages/web-ui/test/screen-grid-acs-display.test.ts`）では「宣言があること」までしか見られない。
// ここは実画素と計算済みスタイルで確かめる担当:
//
//   1. 入力欄の中でもカーソルは重ね要素で描き、native キャレットは透明。位置はキャレットの桁
//   2. ブロックは下の地色を反転する（白の difference＝ACS の XOR）。下線は下端だけ、挿入中は下半分
//   3. 明滅の ON/OFF
//   4. 罫線: 縦線がカーソルの左端、横線がカーソルの行の下端に載る。固定（従わない）で動かない
//   5. ポインター＝十字線
//   6. 桁区切り: 桁の境目ごとに点が出る（`AS400_LIB` の検証プログラム FEATPGM の 2 画面目）
//   7. 端末の配色: クラシック＝ACS の標準色（黒地・#00ff00 …・下線は文字色そのまま）／ソフト＝以前の配色
//
// 実行: node --env-file=.env --env-file=.env.verify scripts/verify-acs-display.mjs
//   （事前に `npm run build` と `npm run build -w @ts5250/web-ui` が要る）
//
// 副作用: 実機へ表示セッションを 1 本張る。入力欄に 1 文字打つが送信はしない。
// ジョブのライブラリー・リストに AS400_LIB を足し（このジョブの中だけ）、FEATPGM を CALL して
// F3 で戻る。PDM でメンバー一覧を表示して F3 で戻る（どちらも読むだけ）。オブジェクトは作らない。装置名はホストに採らせる。
// 自動サインオンが効かずサインオン画面に着いたら、環境変数の資格情報で打ち込む（ログには出さない）。
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serve } from "@hono/node-server";
import { WebSocketServer } from "ws";
import { buildApp, SessionManager, ServerConfigStore, PersonalConfigStore, ConfigResolver } from "@ts5250/server";
import { SecretCrypto } from "../packages/server/dist/secret-crypto.js";
import { createRequire } from "node:module";
import { chromium } from "playwright";

// 画素を読むための PNG デコーダ。依存を増やさないよう、playwright-core が同梱している pngjs を借りる
// （公開 API ではないので、playwright の更新で消えたらここを直す）
const { PNG } = createRequire(import.meta.url)("playwright-core/lib/utilsBundle");

const host = process.env.AS400_HOST;
const user = process.env.AS400_USER;
if (!host || !user || !process.env.AS400_PASSWORD) {
  process.stderr.write("AS400_HOST / AS400_USER / AS400_PASSWORD を環境変数で渡してください\n");
  process.exit(2);
}
const LIB = process.env.AS400_LIB ?? "TESTLIB";
const PORT = Number(process.env.PORT ?? 3491);
/** 許容ずれ（px）。字形の丸めがあるので 0 は要求しない */
const TOL = 1.5;
/** スクリーンショットの置き場（目視用） */
const SHOTS = process.env.SHOT_DIR ?? mkdtempSync(join(tmpdir(), "acsdisp-shots-"));

const log = (s) => process.stdout.write(s + "\n");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0;
let fail = 0;
const check = (cond, msg) => {
  if (cond) { pass++; log(`  PASS ${msg}`); } else { fail++; log(`  FAIL ${msg}`); }
};

const work = mkdtempSync(join(tmpdir(), "acsdisp-"));
const cfgPath = join(work, "profiles.json");
// **パスワードはファイルに書かない**——`passwordEnv` で環境変数を指す
writeFileSync(
  cfgPath,
  JSON.stringify({
    systems: [{ id: "AS400", name: "AS400", host, ccsid: 5035, signon: { user, passwordEnv: "AS400_PASSWORD" } }],
    // **deviceName は書かない。** 共有機なので既存の装置名を奪わない（ホストに採らせる）
    sessions: [{ id: "DSP", name: "DSP", system: "AS400", sessionType: "display" }]
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
// **暗色で測る**——ACS の既定（黒地）と同じ条件で「反転」を画素で見るため
const page = await browser.newPage({ viewport: { width: 1400, height: 900 }, colorScheme: "dark" });

/**
 * メニューを閉じたあと、**カーソルの桁をクリックして画面へフォーカスを戻す**。
 * メニューのボタンがフォーカスを持ったままになるので、戻さないと以降のキー
 * （Insert・矢印・コマンド入力）が画面に届かない。カーソルの桁を押すので位置は変わらない。
 */
async function refocus() {
  const r = await page.locator(".cursor").boundingBox();
  if (r) await page.mouse.click(r.x + r.width / 2, r.y + r.height / 2);
  await sleep(250);
}

/** 表示設定を開いて、行（見出し）を開き、小行の値を押す */
async function setView(group, sub, value) {
  await page.locator("button.vsm-btn").first().click();
  await sleep(150);
  const head = page.locator(".vsm-row", { has: page.locator(".vsm-toggle") }).filter({ hasText: group }).first();
  if ((await head.locator(".vsm-toggle").innerText()).trim() === "開く") await head.locator(".vsm-toggle").click();
  await sleep(100);
  const row = page.locator(".vsm-sub").filter({ has: page.locator(".vsm-label", { hasText: new RegExp(`^\\s*${sub}\\s*$`) }) }).first();
  await row.locator("button", { hasText: new RegExp(`^\\s*${value}\\s*$`) }).click();
  await sleep(100);
  await page.keyboard.press("Escape");
  await sleep(250);
  await refocus();
}
/** 単独の行（桁区切り）を押す */
async function setViewRow(label, value) {
  await page.locator("button.vsm-btn").first().click();
  await sleep(150);
  const row = page.locator(".vsm-row", { hasText: label }).filter({ has: page.locator(".seg") }).first();
  await row.locator("button", { hasText: new RegExp(`^\\s*${value}\\s*$`) }).click();
  await page.keyboard.press("Escape");
  await sleep(250);
  await refocus();
}

/** 画面の実測値（ページの中で測る） */
const probe = () =>
  page.evaluate(() => {
    const grid = document.querySelector(".grid");
    const gs = getComputedStyle(grid);
    const gr = grid.getBoundingClientRect();
    const ruler = grid.querySelector(".cell-ruler");
    const charW = ruler.getBoundingClientRect().width / ruler.textContent.length;
    const lineH = parseFloat(gs.fontSize) * 1.25;
    const rect = (el) => {
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { left: r.left, top: r.top, width: r.width, height: r.height, bottom: r.bottom, right: r.right };
    };
    const cur = document.querySelector(".cursor");
    const cs = cur ? getComputedStyle(cur) : null;
    const act = document.activeElement;
    const inInput = act instanceof HTMLInputElement && act.classList.contains("grid-input");
    return {
      charW, lineH,
      contentLeft: gr.left + parseFloat(gs.borderLeftWidth) + parseFloat(gs.paddingLeft),
      contentTop: gr.top + parseFloat(gs.borderTopWidth) + parseFloat(gs.paddingTop),
      gridCursor: gs.cursor,
      cursor: rect(cur),
      cursorClass: cur?.className ?? null,
      blend: cs?.mixBlendMode ?? null,
      anim: cs?.animationName ?? null,
      input: inInput ? { rect: rect(act), sel: act.selectionStart, caret: getComputedStyle(act).caretColor, pointer: getComputedStyle(act).cursor } : null,
      ruleV: rect(document.querySelector(".rule-v")),
      ruleH: rect(document.querySelector(".rule-h")),
      colsep: [...document.querySelectorAll(".colsep")].map(rect)
    };
  });

/** 画素を読む（デバイス画素比 1 のページ座標） */
async function pixels() {
  const png = PNG.sync.read(await page.screenshot());
  return (x, y) => {
    const i = (Math.round(y) * png.width + Math.round(x)) * 4;
    return [png.data[i], png.data[i + 1], png.data[i + 2]];
  };
}

try {
  await page.goto(`http://127.0.0.1:${PORT}/`);
  await page.waitForSelector(".launcher", { timeout: 15_000 });
  const pick = page.locator(".card", { hasText: "AS400" }).first().locator("button", { hasText: "選択" });
  if (await pick.count()) { await pick.click(); await sleep(400); }
  await page.locator(".card", { hasText: "DSP" }).first().locator("button", { hasText: /^(接続|開く)$/ }).click();
  await page.waitForFunction(() => (document.querySelector(".grid")?.textContent?.length ?? 0) > 400, { timeout: 40_000 });
  await page.waitForFunction(() => document.activeElement?.classList?.contains("grid-input"), { timeout: 15_000 });
  await sleep(1200);

  // ---- 1. 入力欄の中のカーソル ----
  log("\n### 1. 入力欄の中のカーソル（既定＝ブロック・明滅）");
  let m = await probe();
  check(m.input !== null, "コマンド行（入力欄）にフォーカスがある");
  check(m.cursor !== null, "入力欄の中でもカーソルの重ね要素が出る");
  check(/rgba\(0, 0, 0, 0\)|transparent/.test(m.input?.caret ?? ""), `native キャレットは透明（${m.input?.caret}）`);
  const wantLeft = m.input.rect.left + m.input.sel * m.charW;
  check(Math.abs(m.cursor.left - wantLeft) < TOL, `カーソルはキャレットの桁（差 ${(m.cursor.left - wantLeft).toFixed(2)}px）`);
  check(Math.abs(m.cursor.top - m.input.rect.top) < TOL + 1, `カーソルは入力欄の行（差 ${(m.cursor.top - m.input.rect.top).toFixed(2)}px）`);
  check(m.blend === "difference", `重ね方は difference（${m.blend}）`);
  // scoped CSS はキーフレーム名に接尾辞を付ける（cursorBlink-xxxxxxxx）
  check(/^cursorBlink/.test(m.anim ?? ""), `明滅している（${m.anim}）`);

  // 1 文字打つと 1 桁進む（送信はしない）
  const before = m.cursor.left;
  await page.keyboard.type("X");
  await sleep(250);
  m = await probe();
  check(Math.abs(m.cursor.left - before - m.charW) < TOL, `1 文字打つと 1 桁進む（${(m.cursor.left - before).toFixed(2)}px / 桁 ${m.charW.toFixed(2)}px）`);
  await page.keyboard.press("Backspace");
  await sleep(250);

  // ---- 2. 画素: ブロック・下線・挿入 ----
  log("\n### 2. 画素（反転の掛かり方）");
  await setView("カーソル", "明滅", "OFF"); // 明滅の消えている瞬間を撮らないよう止めてから測る
  m = await probe();
  check(m.anim === "none", `明滅 OFF で止まる（${m.anim}）`);
  let px = await pixels();
  const cx = m.cursor.left + m.cursor.width / 2;
  const cyTop = m.cursor.top + 3;
  const bottom = m.cursor.top + m.cursor.height - 1;
  const lowerHalf = m.cursor.top + m.cursor.height * 0.75;
  /**
   * **カーソルの下の画素＝隣の桁の同じ高さの画素**とみなし、それとの関係で判定する。
   * 白の difference は各色を 255 から引いた色になる（ACS の XOR と同じ）。地色との輝度差で見ると、
   * 緑の下線（#00ff00）の反転＝桃色（輝度 105）のように、正しく反転していても差が小さく出る。
   * 空の入力欄の先頭で測るので、隣の桁は字の無い同じ面（地色・欄の塗り・下線）になる。
   */
  const under = (y) => px(cx + m.charW, y);
  const inverted = (y) => px(cx, y).every((v, i) => Math.abs(v - (255 - under(y)[i])) <= 24);
  const untouched = (y) => px(cx, y).every((v, i) => Math.abs(v - under(y)[i]) <= 24);
  log(`  ブロック: 上寄り ${px(cx, cyTop)}（隣 ${under(cyTop)}）/ 下端 ${px(cx, bottom)}（隣 ${under(bottom)}）`);
  check(inverted(cyTop) && inverted(bottom), "ブロックは全面を反転させる");
  await page.screenshot({ path: join(SHOTS, "1-block.png"), clip: { x: m.cursor.left - 200, y: m.cursor.top - 60, width: 500, height: 120 } });

  await setView("カーソル", "形状", "下線");
  m = await probe();
  check(/shape-underline/.test(m.cursorClass), "下線にできる");
  px = await pixels();
  log(`  下線: 上寄り ${px(cx, cyTop)}（隣 ${under(cyTop)}）/ 下端 ${px(cx, bottom)}（隣 ${under(bottom)}）`);
  check(untouched(cyTop), "下線は上寄りを塗らない");
  check(inverted(bottom), "下線は下端を反転させる");
  await page.screenshot({ path: join(SHOTS, "2-underline.png"), clip: { x: m.cursor.left - 200, y: m.cursor.top - 60, width: 500, height: 120 } });

  await page.keyboard.press("Insert");
  await sleep(250);
  m = await probe();
  check(/\bins\b/.test(m.cursorClass), "挿入モードで下半分になる");
  px = await pixels();
  check(untouched(cyTop) && inverted(lowerHalf), "挿入中は上半分が素のまま・下半分が反転");
  await page.screenshot({ path: join(SHOTS, "3-insert.png"), clip: { x: m.cursor.left - 200, y: m.cursor.top - 60, width: 500, height: 120 } });
  await page.keyboard.press("Insert");
  await setView("カーソル", "形状", "ブロック");
  await setView("カーソル", "明滅", "ON");

  // ---- 3. 罫線 ----
  log("\n### 3. 罫線");
  await setView("罫線", "罫線", "ON");
  m = await probe();
  check(m.ruleV !== null && m.ruleH !== null, "十字線（縦・横）が出る");
  check(Math.abs(m.ruleV.left - m.cursor.left) < TOL, `縦線はカーソルの左端（差 ${(m.ruleV.left - m.cursor.left).toFixed(2)}px）`);
  check(Math.abs(m.ruleH.bottom - m.cursor.bottom) < TOL, `横線はカーソルの行の下端（差 ${(m.ruleH.bottom - m.cursor.bottom).toFixed(2)}px）`);
  check(Math.abs(m.ruleH.left - m.contentLeft) < TOL, "横線は画面の左端から");
  await page.screenshot({ path: join(SHOTS, "4-rule.png") });

  // 固定: 従わない → カーソルを動かしても残る
  await setView("罫線", "カーソルに従う", "いいえ");
  const fixed = await probe();
  await page.keyboard.press("ArrowUp");
  await page.keyboard.press("ArrowUp");
  await sleep(250);
  m = await probe();
  check(Math.abs(m.cursor.top - fixed.cursor.top) > m.lineH, "カーソルは動いた");
  check(Math.abs(m.ruleH.top - fixed.ruleH.top) < TOL, "固定した横線は動かない");
  await setView("罫線", "カーソルに従う", "はい");
  m = await probe();
  check(Math.abs(m.ruleH.bottom - m.cursor.bottom) < TOL, "従うに戻すとカーソルの行へ戻る");
  await setView("罫線", "スタイル", "水平");
  m = await probe();
  check(m.ruleV === null && m.ruleH !== null, "水平は横線だけ");
  await setView("罫線", "罫線", "OFF");
  m = await probe();
  check(m.ruleV === null && m.ruleH === null, "OFF で消える");
  await setView("罫線", "スタイル", "十字線");

  // ---- 4. ポインター ----
  log("\n### 4. ポインター");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("ArrowDown");
  await sleep(250);
  await setView("カーソル", "ポインター", "十字線");
  m = await probe();
  check(m.gridCursor === "crosshair", `画面の上は十字線（${m.gridCursor}）`);
  check(m.input?.pointer === "crosshair", `入力欄の上も十字線（${m.input?.pointer}）`);
  await setView("カーソル", "ポインター", "標準");
  m = await probe();
  check(m.gridCursor !== "crosshair", `標準に戻る（${m.gridCursor}）`);

  // ---- 5. 桁区切り ----
  // FEATPGM（`AS400_LIB` に既にある検証プログラム）の 2 画面目「COLOR / BG / DSPATR TEST」には
  // `DSPATR(CS)` の行（CS colsep）と、青緑・黄の文字（0x30–0x37＝ACS が点を打つ属性）がある。
  log("\n### 5. 桁区切り（FEATPGM「COLOR / BG / DSPATR TEST」）");
  const screenText = () => page.locator(".grid").innerText();
  /**
   * 入力欄の**先頭**から打てるようにする。クリックは要素の中央を押すので、キャレットが欄の途中に
   * 置かれてしまう（そこから打つと欄の先頭に空白が残り、名前として拒否される）。
   * フォーカスし直せば欄の先頭に置かれる（`onInputFocus`）。
   */
  const focusInput = async (which) => {
    await page.evaluate(() => (document.activeElement instanceof HTMLElement ? document.activeElement.blur() : undefined));
    const inputs = page.locator("input.grid-input:not([readonly])");
    await (which === "first" ? inputs.first() : inputs.last()).focus();
    await sleep(200);
  };
  if ((await screenText()).includes("サイン・オン")) {
    // 自動サインオンが効かなかった環境向け。**パスワードはログに出さない**
    await focusInput("first");
    await page.keyboard.type(user);
    await page.keyboard.press("Tab");
    await page.keyboard.type(process.env.AS400_PASSWORD);
    await page.keyboard.press("Enter");
    await sleep(2000);
    // 「サインオン情報」（前回のサインオン等）と「プログラム・メッセージの表示」（別のジョブが
    // メッセージ待ち行列を持っている等）は実行キーで先へ進む。文言は「続行するには」「続行するためには」
    for (let i = 0; i < 4 && /続行するに|続行するため/.test(await screenText()); i++) {
      await page.keyboard.press("Enter");
      await sleep(2000);
    }
    await page.waitForFunction(() => /===>/.test(document.querySelector(".grid")?.textContent ?? ""), { timeout: 30_000 }).catch(() => {});
    await sleep(1000);
  }
  if (!/===>/.test(await screenText())) {
    log("  （コマンド行に着けないので飛ばす）");
    await page.screenshot({ path: join(SHOTS, "5-no-cmdline.png") });
    log((await screenText()).split("\n").slice(0, 24).map((l) => "  | " + l).join("\n"));
  } else {
    // FEATPGM は表示装置ファイルを *LIBL から開く。ライブラリー・リストはこのジョブの中だけの変更
    // （既に載っていればエラーになるが、そのまま進んでよい）
    await focusInput("last");
    await page.keyboard.type(`ADDLIBLE LIB(${LIB})`);
    await page.keyboard.press("Enter");
    await sleep(2000);
    await focusInput("last");
    await page.keyboard.type(`CALL ${LIB}/FEATPGM`);
    await page.keyboard.press("Enter");
    await page.waitForFunction(() => /EDTCDE/.test(document.querySelector(".grid")?.textContent ?? ""), { timeout: 20_000 }).catch(() => {});
    await sleep(800);
    await page.keyboard.press("Enter");
    await page.waitForFunction(() => /DSPATR TEST/.test(document.querySelector(".grid")?.textContent ?? ""), { timeout: 20_000 }).catch(() => {});
    await sleep(800);
    if (!(await screenText()).includes("CS colsep")) {
      log("  （FEATPGM の画面に着けないので飛ばす）");
      await page.screenshot({ path: join(SHOTS, "5-no-featpgm.png") });
      log((await screenText()).split("\n").slice(0, 24).map((l) => "  | " + l).join("\n"));
    } else {
      /** 語を含む行の上端・下端 */
      const rowBox = (word) =>
        page.evaluate((word) => {
          const el = [...document.querySelectorAll(".grid .grid-row")].find((r) => (r.textContent ?? "").includes(word));
          const b = el?.getBoundingClientRect();
          return b ? { top: b.top, bottom: b.bottom } : null;
        }, word);
      m = await probe();
      log(`  点 ${m.colsep.length} 個`);
      for (const word of ["CS colsep", "TRQ text", "YLW text"]) {
        const b = await rowBox(word);
        const n = m.colsep.filter((r) => b && r.top >= b.top && r.bottom <= b.bottom + 0.5).length;
        check(n > 0, `「${word}」の行に点が出る（${n} 個）`);
      }
      const green = await rowBox("GRN text");
      check(!m.colsep.some((r) => green && r.top >= green.top && r.bottom <= green.bottom + 0.5), "緑の行（GRN text）には出ない");
      const first = m.colsep[0];
      check(first.height >= 2.5 && first.height <= 3.5, `点は 3px（${first?.height}）`);
      const sameRow = m.colsep.filter((r) => Math.abs(r.top - first.top) < 0.5).map((r) => r.left).sort((a, b) => a - b);
      const gaps = sameRow.slice(1).map((x, i) => x - sameRow[i]);
      const minGap = Math.min(...gaps);
      check(Math.abs(minGap - m.charW) < TOL, `点の間隔は 1 桁（${minGap.toFixed(2)}px / 桁 ${m.charW.toFixed(2)}px）`);
      await page.screenshot({ path: join(SHOTS, "5-colsep-dot.png") });
      await setViewRow("桁区切り", "線");
      m = await probe();
      check(m.colsep.length > 0 && m.colsep[0].height > m.lineH - 2, `線は行の高さ（${m.colsep[0]?.height.toFixed(1)} / 行 ${m.lineH.toFixed(1)}）`);
      await page.screenshot({ path: join(SHOTS, "6-colsep-line.png") });
      await setViewRow("桁区切り", "オフ");
      m = await probe();
      check(m.colsep.length === 0, "オフで消える");
      await setViewRow("桁区切り", "ドット");
    }
    // FEATPGM は F3 を押しても次の画面へ進むことがある。コマンド行に戻るまで繰り返す
    for (let i = 0; i < 4 && !/===>/.test(await screenText()); i++) {
      await page.keyboard.press("F3");
      await sleep(2000);
    }

    // ---- 6. 端末の配色（外観 > 5250 端末 クラシック / ソフト） ----
    // 利用者の比較画面（PDM のメンバー一覧）で撮る。ソース物理ファイルが無ければ今の画面で測るだけ
    log("\n### 6. 端末の配色（クラシック＝ACS の標準色 / ソフト＝以前の配色）");
    // F3 の応答（メインメニュー）が描き終わってから打つ。先に打つと描き直しで入力が消える
    await page.waitForFunction(() => /===>/.test(document.querySelector(".grid")?.textContent ?? ""), { timeout: 20_000 }).catch(() => {});
    await sleep(1000);
    await focusInput("last");
    await page.keyboard.type(`WRKMBRPDM FILE(${LIB}/QRPGSRC)`);
    await page.keyboard.press("Enter");
    const onPdm = await page
      .waitForFunction(() => /PDM/.test(document.querySelector(".grid")?.textContent ?? ""), { timeout: 20_000 })
      .then(() => true, () => false);
    log(onPdm ? "  PDM のメンバー一覧で測る" : "  （PDM に着けないので今の画面で測る）");
    await sleep(1000);
    const colors = () =>
      page.evaluate(() => {
        const pick = (sel) => {
          const el = document.querySelector(sel);
          return el ? getComputedStyle(el) : null;
        };
        const ul = pick(".grid-input.a-underline, .grid-span.a-underline");
        return {
          bg: pick(".grid")?.backgroundColor,
          green: pick(".grid-span.c-green")?.color,
          blue: pick(".grid-span.c-blue")?.color,
          ulText: ul?.color,
          ulLine: ul?.borderBottomColor
        };
      });
    const setTerminal = async (tag) => {
      await page.locator(".dz-btn").click();
      await sleep(150);
      await page.locator(".dz-opt", { has: page.locator(".tag", { hasText: new RegExp(`^${tag}$`) }) }).click();
      await page.keyboard.press("Escape");
      await sleep(300);
    };
    /**
     * 色の表記を [r, g, b, a] に揃える。`color-mix` の結果は `color(srgb 0 1 0)` の形で返り、
     * 素の指定は `rgb(0, 255, 0)` で返る——同じ色でも文字列では一致しない。
     */
    const rgba = (v) => {
      if (!v) return null;
      let m = /^rgba?\(([^)]*)\)$/.exec(v);
      if (m) {
        const [r, g, b, a = 1] = m[1].split(/[ ,/]+/).filter(Boolean).map(Number);
        return [r, g, b, a];
      }
      m = /^color\(srgb ([^)]*)\)$/.exec(v);
      if (m) {
        const [r, g, b, a = 1] = m[1].split(/[ /]+/).filter(Boolean).map(Number);
        return [Math.round(r * 255), Math.round(g * 255), Math.round(b * 255), a];
      }
      return null;
    };
    const sameColor = (x, y) => JSON.stringify(rgba(x)) === JSON.stringify(rgba(y));
    let c = await colors();
    log(`  クラシック: ${JSON.stringify(c)}`);
    check(c.bg === "rgb(0, 0, 0)", `地色は黒（${c.bg}）`);
    check(c.green === "rgb(0, 255, 0)", `緑は #00ff00（${c.green}）`);
    check(c.blue === undefined || c.blue === "rgb(120, 144, 240)", `青は rgb(120,144,240)（${c.blue}）`);
    check(c.ulLine === undefined || sameColor(c.ulLine, c.ulText), `下線は文字色そのまま（線 ${c.ulLine} / 字 ${c.ulText}）`);
    await page.screenshot({ path: join(SHOTS, "7-classic.png") });
    await setTerminal("ソフト");
    c = await colors();
    log(`  ソフト: ${JSON.stringify(c)}`);
    check(c.bg === "rgb(5, 13, 9)", `ソフトの地色は以前の値（${c.bg}）`);
    check(c.green === "rgb(61, 220, 132)", `ソフトの緑は以前の値（${c.green}）`);
    check(c.ulLine === undefined || rgba(c.ulLine)?.[3] < 1, `ソフトの下線は淡いまま（線 ${c.ulLine}）`);
    await page.screenshot({ path: join(SHOTS, "8-soft.png") });
    await setTerminal("クラシック");
    c = await colors();
    check(c.bg === "rgb(0, 0, 0)", "クラシックへ戻せる");
    if (onPdm) {
      await page.keyboard.press("F3");
      await sleep(1500);
    }
  }
  log(`\n  スクリーンショット: ${SHOTS}`);
} catch (e) {
  fail++;
  log(`  FAIL 例外: ${e?.message ?? e}`);
  try {
    await page.screenshot({ path: join(SHOTS, "error.png") });
    const t = await page.locator("body").innerText();
    log("  --- 画面 ---\n" + t.split("\n").slice(0, 30).map((l) => "  | " + l).join("\n"));
  } catch { /* 良い */ }
} finally {
  await browser.close().catch(() => {});
  for (const s of sessions.list()) {
    try { await sessions.close(s.id); } catch { /* 良い */ }
  }
  server.close();
  wss.close();
  try { rmSync(work, { recursive: true, force: true }); } catch { /* 良い */ }
}

log(`\n${fail === 0 ? "OK" : "NG"} — ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
