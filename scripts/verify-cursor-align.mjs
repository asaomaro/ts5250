// **カーソルと文字が同じ桁・同じ行に載るか**を実ブラウザで測る（`20260802-cursor-pad-offset`）。
//
// jsdom は scoped CSS を計算しないので、単体テストでは「ずれ」そのものを測れない
// （`test/grid-overlay-offset.test.ts` が見ているのは *ずれを生む書き方* だけ）。
// ここは実画素で確かめる担当:
//
//   1. 保護領域を**クリックした桁**へカーソルが行く（クリックの桁逆算）
//   2. カーソルの矩形が、**その桁の文字の矩形**と重なる（重ねる要素の余白補正）
//   3. カーソルの矩形が、`.grid` の content box から計算した桁・行の位置と一致する
//
// 直す前は 2 と 3 が右へ 8px・下へ 7px ずれていた（`.grid` の padding を ACS 相当へ
// 詰めたのに、重ねる要素の `margin: 8px 0 0 10px` が 12 か所残っていた）。
//
// 実行: node --env-file=.env scripts/verify-cursor-align.mjs
//   （事前に `npm run build` と `npm run build -w @ts5250/web-ui` が要る）
//
// 副作用: 実機へ表示セッションを 1 本張って**画面を読むだけ**。装置名は指定せず
// ホストに採らせる（共有機なので既存の装置名を奪わない）。オブジェクトは作らない。
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
const PORT = Number(process.env.PORT ?? 3489);
/** 許容ずれ（px）。字形の丸めがあるので 0 は要求しない。直す前のずれは 8px / 7px だった */
const TOL = 1.5;

const log = (s) => process.stdout.write(s + "\n");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0;
let fail = 0;
const check = (cond, msg) => {
  if (cond) { pass++; log(`  PASS ${msg}`); } else { fail++; log(`  FAIL ${msg}`); }
};

const work = mkdtempSync(join(tmpdir(), "curalign-"));
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
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });

/**
 * 画面の実測値を 1 度に採る。**ページの中で測る**——`.grid` は font-size を実測で
 * 決めるので、外から桁幅を推定すると測る対象がずれる。
 *
 * `wantRow` / `wantCol` は「そこの文字の矩形」を返してほしい桁・行。
 */
const probe = (wantRow, wantCol) =>
  page.evaluate(
    ({ wantRow, wantCol }) => {
      const grid = document.querySelector(".grid");
      if (!grid) return { error: ".grid が無い" };
      const gs = getComputedStyle(grid);
      const gr = grid.getBoundingClientRect();
      const ruler = grid.querySelector(".cell-ruler");
      if (!ruler) return { error: ".cell-ruler が無い（字幅を測れない）" };
      const charW = ruler.getBoundingClientRect().width / ruler.textContent.length;
      const lineH = parseFloat(gs.fontSize) * 1.25;
      // content box の左上（絶対配置の基準は padding box なので、余白ぶんを足す）
      const contentLeft = gr.left + parseFloat(gs.borderLeftWidth) + parseFloat(gs.paddingLeft);
      const contentTop = gr.top + parseFloat(gs.borderTopWidth) + parseFloat(gs.paddingTop);

      /** 半角しか無い行を選ぶ（全角は 1 文字で 2 桁を占め、文字 index と桁が食い違う） */
      const sbcsRows = [];
      const rowEls = grid.querySelectorAll(".grid-row");
      rowEls.forEach((el, i) => {
        if (el.querySelector("input")) return; // 入力欄がある行は桁と文字数がずれる
        const t = el.textContent ?? "";
        if (t.length !== 80) return;
        if (/[^\x20-\x7e]/.test(t)) return;
        if (t.trim().length < 10) return; // 空行では見て分からない
        sbcsRows.push(i + 1);
      });

      /** その桁の文字 1 つぶんの矩形（Range で実際の字を測る） */
      const glyphRect = (row, col) => {
        const el = rowEls[row - 1];
        if (!el) return null;
        const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
        let acc = 0;
        let n;
        while ((n = walker.nextNode())) {
          if (acc + n.data.length > col - 1) {
            const off = col - 1 - acc;
            const r = document.createRange();
            r.setStart(n, off);
            r.setEnd(n, off + 1);
            const b = r.getBoundingClientRect();
            return { left: b.left, top: b.top, width: b.width, height: b.height };
          }
          acc += n.data.length;
        }
        return null;
      };

      const cur = document.querySelector(".cursor");
      const c = cur?.getBoundingClientRect();
      return {
        charW, lineH, contentLeft, contentTop, sbcsRows,
        // カーソルが「自分は何桁目のつもりか」——inline style は (col-1)ch / (row-1)*1.25em
        cursorCol: cur ? Math.round(parseFloat(cur.style.left)) + 1 : null,
        cursorRow: cur ? Math.round(parseFloat(cur.style.top) / 1.25) + 1 : null,
        cursor: cur ? { left: c.left, top: c.top, width: c.width, height: c.height } : null,
        glyph: wantRow ? glyphRect(wantRow, wantCol) : null
      };
    },
    { wantRow, wantCol }
  );

try {
  await page.goto(`http://127.0.0.1:${PORT}/`);
  await page.waitForSelector(".launcher", { timeout: 15_000 });
  const pick = page.locator(".card", { hasText: "AS400" }).first().locator("button", { hasText: "選択" });
  if (await pick.count()) { await pick.click(); await sleep(400); }
  await page.locator(".card", { hasText: "DSP" }).first().locator("button", { hasText: /^(接続|開く)$/ }).click();
  // 画面が埋まるまで待つ（サインオン→着地に数秒かかる）
  await page.waitForFunction(() => (document.querySelector(".grid")?.textContent?.length ?? 0) > 400, { timeout: 40_000 });
  await sleep(1500);

  const base = await probe(null, null);
  if (base.error) throw new Error(base.error);
  const row = base.sbcsRows[0];
  if (row === undefined) throw new Error("半角だけの行が見つからない（測る足場が無い）");
  const col = 20;
  log(`### 足場: 行 ${row} 桁 ${col}（字幅 ${base.charW.toFixed(2)}px / 行高 ${base.lineH.toFixed(2)}px）`);

  // ---- 1. クリックした桁へカーソルが行く ----
  log("\n### 1. クリックの桁逆算");
  await page.mouse.click(base.contentLeft + (col - 0.5) * base.charW, base.contentTop + (row - 0.5) * base.lineH);
  await sleep(400);
  const m = await probe(row, col);
  if (!m.cursor) throw new Error("クリックしてもブロックカーソルが出ない（保護領域ではない？）");
  check(m.cursorCol === col, `クリックした桁にカーソルが行く（想定 ${col} / 実際 ${m.cursorCol}）`);
  check(m.cursorRow === row, `クリックした行にカーソルが行く（想定 ${row} / 実際 ${m.cursorRow}）`);

  // ---- 2. カーソルの矩形 = その桁の文字の矩形 ----
  log("\n### 2. カーソルと文字が重なる（利用者の指摘そのもの）");
  if (!m.glyph) throw new Error("その桁の文字を測れない");
  const dxg = m.cursor.left - m.glyph.left;
  // **縦は「上端」ではなく「中心」で見る。** Range が返すのは字の inline box で、
  // 行box（line-height 1.25em）とは高さが違う（フォント次第で高くも低くもなる。
  // 実機の実測では行box 32.5px に対し字 37.0px）。上端どうしを比べると、
  // 正しく載っていても差の半分（half-leading）ぶんずれて見える。
  const dyg = (m.cursor.top + m.cursor.height / 2) - (m.glyph.top + m.glyph.height / 2);
  check(Math.abs(dxg) < TOL, `**横のずれが無い**（${dxg.toFixed(2)}px）`);
  check(
    Math.abs(dyg) < TOL,
    `**縦のずれが無い**（中心の差 ${dyg.toFixed(2)}px / カーソル ${m.cursor.height.toFixed(1)}px・字 ${m.glyph.height.toFixed(1)}px）`
  );

  // ---- 3. content box から計算した位置と一致 ----
  log("\n### 3. 余白の補正が効いている");
  const dx = m.cursor.left - (m.contentLeft + (col - 1) * m.charW);
  const dy = m.cursor.top - (m.contentTop + (row - 1) * m.lineH);
  check(Math.abs(dx) < TOL, `横位置が content box 基準と一致（${dx.toFixed(2)}px）`);
  check(Math.abs(dy) < TOL, `縦位置が content box 基準と一致（${dy.toFixed(2)}px）`);
  check(Math.abs(m.cursor.width - m.charW) < TOL, `幅が 1 桁ぶん（${m.cursor.width.toFixed(2)} vs ${m.charW.toFixed(2)}）`);
} catch (e) {
  fail++;
  log(`  FAIL 例外: ${e?.message ?? e}`);
  try {
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
