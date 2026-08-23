// Web エミュレータ（実ブラウザの web-ui）の表示と、実機から受けた画面そのもの
// （Session5250 のスナップショット）を突き合わせる。
//
// **同じセッションを共有する**のが要点。サーバーをこのプロセス内で建て、ブラウザは
// その web-ui に繋ぐので、DOM を読んだ瞬間の snapshot() が同じ画面である保証が取れる。
// 別セッションを 2 本張って比べると、装置名もジョブも別になり差が出て当然になる。
//
// 見るのは 4 つ:
//   1. 文字   — 行ごとの文字列（全角は 1 文字として数える）
//   2. 属性   — 文字ごとの色・下線・反転・点滅・桁区切り
//   3. 桁位置 — 入力欄が占める桁を **ブラウザ上の実測 px から ch に換算**して照合
//   4. カーソル — 実測位置
//
// 実行: AS400_USER=.. AS400_PASSWORD=.. node --env-file=.env --env-file=.env.verify scripts/diff-webui-vs-host.mjs <出力先>
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { serve } from "@hono/node-server";
import { WebSocketServer } from "ws";
import { buildApp, SessionManager, ServerConfigStore, PersonalConfigStore, ConfigResolver } from "@ts5250/server";
import { SecretCrypto } from "../packages/server/dist/secret-crypto.js";
import { chromium } from "playwright";

const OUT = process.argv[2] ?? "webui-diff";
mkdirSync(OUT, { recursive: true });
const PORT = 3512;
const LIB = process.env.AS400_LIB ?? "TESTLIB";
const PROGRAMS = process.env.ONLY ? process.env.ONLY.split(",") : [
  "ADJPGM", "DTMPGM", "EDTPGM", "EMPSFR", "EXTPGM", "FEATPGM", "FFWPGM", "OPTPGM", "SGNPGM",
  "GRIDCL", "GRIDCL2", "GRIDCL3", "GRIDCL4", "GRIDCL5", "GRIDCL6", "GRIDCL7"
];
const MAX_ADVANCE = 6;

const log = (s) => process.stderr.write(s + "\n");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// **装置名を固定したまま比較を回さない。** DEV1 を使い回すと、前回の切断が残っている限り
// 「対話式ジョブの回復」画面から始まり、比較したい画面に辿り着けない。
// 設定を写して装置名だけ空にし、ホスト採番に任せる（shot-ext.mjs と同じ流儀）。
const cfg = JSON.parse(readFileSync("connections.json", "utf8"));
for (const sess of cfg.sessions) if (sess.name === (process.env.AS400_SESSION ?? "DEV1")) sess.deviceName = "";
const tmpCfg = `${OUT}/conn-diff.json`;
writeFileSync(tmpCfg, JSON.stringify(cfg));

const crypto = SecretCrypto.fromEnv();
const resolver = new ConfigResolver(
  ServerConfigStore.fromFile(tmpCfg, crypto),
  new PersonalConfigStore({ systems: [], sessions: [] }, crypto)
);
const sessions = new SessionManager();
const app = buildApp({ sessions, resolver, version: "diff", webRoot: "packages/web-ui/dist" });
const wss = new WebSocketServer({ noServer: true });
const server = serve({ fetch: app.fetch, port: PORT, websocket: { server: wss } });
await sleep(600);

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1600, height: 900 }, deviceScaleFactor: 2 });
page.on("pageerror", (e) => log("PAGEERR " + e.message));
const bodyText = () => page.locator("body").innerText();
const has = async (t) => (await bodyText()).includes(t);
const clickEnter = async () => {
  const b = page.getByText("⏎ 実行", { exact: false }).first();
  if (await b.count()) await b.click();
  else await page.keyboard.press("Enter");
};
const pressF = async (n) => {
  const b = page.locator("button.fkey-btn", { hasText: new RegExp(`^F${n}\\b`) }).first();
  if (await b.count()) await b.click();
  else await page.keyboard.press(`F${n}`);
};
const type = async (text) => {
  const inp = page.locator("input.grid-input").first();
  await inp.click();
  await page.keyboard.press("Home");
  await page.keyboard.type(text, { delay: 20 });
};

/**
 * ブラウザ側の見え方を採る。
 * 文字は「全角 1 文字＝1 要素」。桁位置は **実測 px を ch で割って**出す
 * （CSS の ch と実フォントで本当に桁が合っているかを見たいので、計算値ではなく実測）。
 */
function domView() {
  const ruler = document.querySelector(".cell-ruler");
  const chW = ruler.getBoundingClientRect().width / 10;
  const rows = [...document.querySelectorAll(".grid .grid-row")];
  // **原点は .grid の矩形ではなく 1 行目の矩形。** .grid は padding を持つので、
  // border box の左上を基準にすると桁が丸ごと 1 つずれる（screen-html.ts の注記と同じ話）。
  const gr = rows[0].getBoundingClientRect();
  const rowH = gr.height;
  const clsOf = (el) => [...el.classList].filter((x) => /^(c-|a-)/.test(x)).sort().join(" ");
  const out = rows.map((row) => {
    let text = "";
    const attrs = [];
    const mask = [];
    for (const node of row.children) {
      if (node.classList.contains("input-cell")) {
        const inp = node.querySelector("input.grid-input");
        if (!inp) continue;
        const r = inp.getBoundingClientRect();
        const col0 = Math.round((r.left - gr.left) / chW);
        const w = Math.round(r.width / chW);
        for (let i = 0; i < w; i++) mask.push(col0 + i);
        const v = (inp.value ?? "").slice(0, w);
        for (const ch of v.padEnd(w, " ")) { text += ch; attrs.push(clsOf(inp)); }
      } else if (node.classList.contains("grid-span")) {
        for (const ch of node.textContent || "") { text += ch; attrs.push(clsOf(node)); }
      }
    }
    return { text, attrs, mask };
  });
  // 拡張5250 のオーバーレイ（罫線・ウィンドウ枠・スクロールバー・選択フィールド）。
  // 桁行に載る要素なので、実測 px を ch / 行高に戻して座標で比べられる形にする。
  const box = (el) => {
    const r = el.getBoundingClientRect();
    return {
      row: Math.round((r.top - gr.top) / rowH) + 1,
      col: Math.round((r.left - gr.left) / chW) + 1,
      w: Math.round(r.width / chW),
      h: Math.round(r.height / rowH)
    };
  };
  const overlay = {
    gridLines: [...document.querySelectorAll(".grid .grid-line")].map(box),
    windows: [...document.querySelectorAll(".grid .gui-window")].map(box),
    scrollBars: [...document.querySelectorAll(".grid .gui-scrollbar")].map(box),
    selections: [...document.querySelectorAll(".grid .gui-selection")].map((el) => ({
      ...box(el),
      choices: [...el.querySelectorAll(".gui-choice-text")].map((c) => c.textContent)
    }))
  };
  const cur = document.querySelector(".grid > .cursor");
  let cursor = null;
  if (cur) {
    const r = cur.getBoundingClientRect();
    cursor = {
      row: Math.round((r.top - gr.top) / rowH) + 1,
      col: Math.round((r.left - gr.left) / chW) + 1
    };
  } else {
    const f = document.activeElement;
    if (f && f.classList && f.classList.contains("grid-input")) cursor = { inInput: true };
  }
  return { rows: out, cursor, overlay };
}

/** スナップショットを同じ数え方（全角 1 文字・属性クラスは web-ui の綴り）に起こす */
function hostView(snap) {
  const hasRealColsep = (color, cs) => cs && color !== "yellow" && color !== "turquoise";
  const rows = snap.cells.map((row) => {
    let text = "";
    const attrs = [];
    const mask = [];
    for (let i = 0; i < row.length; i++) {
      const c = row[i];
      if (c.kind === "dbcs-tail") continue; // 全角は lead の 1 文字だけ数える
      const cls = [`c-${c.color}`];
      if (c.underline) cls.push("a-underline");
      if (c.reverse) cls.push("a-reverse");
      if (c.blink) cls.push("a-blink");
      if (hasRealColsep(c.color, c.columnSeparator)) cls.push("a-colsep");
      text += c.nonDisplay ? " " : (c.char === "" ? " " : c.char);
      attrs.push(cls.sort().join(" "));
    }
    return { text, attrs, mask };
  });
  // 入力欄が占める桁（0 始まり）。行またぎの欄も桁を追って展開する
  for (const f of snap.fields) {
    for (let k = 0; k < f.length; k++) {
      const abs = (f.row - 1) * snap.cols + (f.col - 1) + k;
      const r = Math.floor(abs / snap.cols);
      const c = abs % snap.cols;
      if (r < rows.length) rows[r].mask.push(c);
    }
  }
  return { rows, cursor: { row: snap.cursor.row, col: snap.cursor.col } };
}

const findings = [];
let compared = 0;
const add = (f) => findings.push(f);

const cmp = async (label) => {
  const entry = sessions.list()[0];
  const before = entry.session.snapshot();
  const dom = await page.evaluate(domView);
  const after = entry.session.snapshot();
  const host = hostView(after);
  if (JSON.stringify(hostView(before).rows.map((r) => r.text)) !== JSON.stringify(host.rows.map((r) => r.text))) {
    add({ label, kind: "unstable", detail: "DOM 読み取り中に画面が変わった（比較を見送り）" });
    return;
  }
  compared++;
  if (dom.rows.length !== host.rows.length) {
    add({ label, kind: "rows", detail: `行数 DOM=${dom.rows.length} 実機=${host.rows.length}` });
  }
  const n = Math.min(dom.rows.length, host.rows.length);
  for (let r = 0; r < n; r++) {
    const d = dom.rows[r], h = host.rows[r];
    const dt = d.text.replace(/\s+$/, ""), ht = h.text.replace(/\s+$/, "");
    if (dt !== ht) {
      let i = 0;
      while (i < Math.min(dt.length, ht.length) && dt[i] === ht[i]) i++;
      const cp = (str, k) => (str[k] === undefined ? "—" : "U+" + str.codePointAt(k).toString(16).toUpperCase());
      // 文字差が出た行は、セル列と DOM 要素をそのまま採っておく（原因を後で追えるように）
      const hostCells = after.cells[r].map((c, k) => ({ col: k + 1, kind: c.kind, ch: c.char, cp: c.char ? "U+" + c.char.codePointAt(0).toString(16).toUpperCase() : "" }))
        .filter((x) => x.ch !== " " && x.ch !== "");
      const domNodes = await page.evaluate((rr) => {
        const row = document.querySelectorAll(".grid .grid-row")[rr];
        return [...row.children].map((n) => ({ cls: n.className, text: n.textContent }))
          .filter((n) => (n.text ?? "").trim() !== "");
      }, r);
      add({
        label, kind: "text", row: r + 1, at: i + 1,
        dom: dt.slice(Math.max(0, i - 6), i + 20), host: ht.slice(Math.max(0, i - 6), i + 20),
        domCp: cp(dt, i), hostCp: cp(ht, i), domLen: dt.length, hostLen: ht.length,
        hostCells, domNodes
      });
      continue;
    }
    for (let i = 0; i < Math.min(d.attrs.length, h.attrs.length); i++) {
      if (ht[i] === undefined || ht[i] === " ") continue; // 空白の色差は目に出ない
      if (d.attrs[i] !== h.attrs[i]) {
        add({ label, kind: "attr", row: r + 1, at: i + 1, char: ht[i], dom: d.attrs[i], host: h.attrs[i] });
        break;
      }
    }
    const dm = [...new Set(d.mask)].sort((a, b) => a - b).join(",");
    const hm = [...new Set(h.mask)].sort((a, b) => a - b).join(",");
    if (dm !== hm) add({ label, kind: "fieldcols", row: r + 1, dom: dm, host: hm });
  }
  // オーバーレイは「数」と「見えている選択肢の文字」で照合する。
  // 枠の実測座標は装飾（影・枠線）の付け方で数 px 動くため、個数と中身のずれを見る。
  const g = after.gui;
  const expect = {
    gridLines: g ? g.gridLines.length : 0,
    windows: g ? g.windows.length : 0,
    scrollBars: g ? g.scrollBars.length : 0,
    selections: g ? g.selectionFields.length : 0
  };
  const got = {
    gridLines: dom.overlay.gridLines.length,
    windows: dom.overlay.windows.length,
    scrollBars: dom.overlay.scrollBars.length,
    selections: dom.overlay.selections.length
  };
  // 罫線は 1 本を複数の辺（div）に割って描くので、本数そのものは一致しない。0/非0 だけ見る
  if ((expect.gridLines > 0) !== (got.gridLines > 0)) {
    add({ label, kind: "gui", what: "gridLines", dom: got.gridLines, host: expect.gridLines });
  }
  for (const k of ["windows", "scrollBars", "selections"]) {
    if (expect[k] !== got[k]) add({ label, kind: "gui", what: k, dom: got[k], host: expect[k] });
  }
  if (g) {
    for (let i = 0; i < Math.min(g.windows.length, dom.overlay.windows.length); i++) {
      const w = g.windows[i], d = dom.overlay.windows[i];
      if (d.row !== w.row || d.col !== w.col) {
        add({ label, kind: "guipos", what: `window${i}`, dom: { row: d.row, col: d.col }, host: { row: w.row, col: w.col } });
      }
    }
    for (let i = 0; i < Math.min(g.selectionFields.length, dom.overlay.selections.length); i++) {
      const f = g.selectionFields[i], d = dom.overlay.selections[i];
      const ht = f.choices.map((c) => c.text).join("|");
      const dt = d.choices.join("|");
      if (ht !== dt) add({ label, kind: "guitext", what: `selection${i}`, dom: dt, host: ht });
    }
  }
  if (dom.cursor && !dom.cursor.inInput) {
    if (dom.cursor.row !== host.cursor.row || dom.cursor.col !== host.cursor.col) {
      add({ label, kind: "cursor", dom: dom.cursor, host: host.cursor });
    }
  }
};

try {
  await page.goto(`http://localhost:${PORT}/`);
  await page.waitForSelector(".launcher", { timeout: 20000 });
  await page.click(".card:has-text('実機') >> button:has-text('選択')");
  await page.waitForSelector(".card:has-text('DEV1')", { timeout: 10000 });
  await page.click(".card:has-text('DEV1') >> button:has-text('接続')");
  await page.waitForFunction(() => document.querySelectorAll(".grid .grid-row").length > 0, { timeout: 25000 });
  await sleep(900);

  // **画面の判定を文字列の部分一致に頼らない。**「サインオフ」も「サイン」を含む。
  const pwCount = () => page.locator('input.grid-input[autocomplete="off"]').count();
  for (let i = 0; i < 15; i++) {
    if (await has("メインメニュー")) break;
    const t = await bodyText();
    if (t.includes("対話式ジョブの回復")) { await type("90"); await clickEnter(); }
    else if ((await pwCount()) > 0) {
      const inputs = page.locator("input.grid-input");
      await inputs.nth(0).pressSequentially(process.env.AS400_USER ?? "USER", { delay: 40 });
      await sleep(120);
      await page.locator('input.grid-input[autocomplete="off"]').first()
        .pressSequentially(process.env.AS400_PASSWORD ?? "", { delay: 40 });
      await sleep(150);
      await clickEnter();
    } else if (t.includes("続行するには")) await clickEnter();
    else await pressF(12);
    await sleep(1300);
  }
  if (!(await has("メインメニュー"))) throw new Error("メインメニューに着けない");
  log("メインメニュー到達");
  await cmp("MAIN メニュー");

  await type(`ADDLIBLE ${LIB}`); await clickEnter(); await sleep(1300);

  const backToMenu = async () => {
    for (let i = 0; i < 5; i++) {
      if (await has("メインメニュー")) return true;
      if (await has("プログラム・メッセージの表示")) { await type("C"); await clickEnter(); }
      else await pressF(i % 2 === 0 ? 3 : 12);
      await sleep(1300);
    }
    return await has("メインメニュー");
  };

  for (const pgm of PROGRAMS) {
    log(`--- ${pgm} ---`);
    await type(`CALL ${LIB}/${pgm}`); await clickEnter(); await sleep(1900);
    let shots = 0;
    for (let i = 0; i < MAX_ADVANCE; i++) {
      if (await has("メインメニュー")) break;
      if (await has("プログラム・メッセージの表示")) break;
      await cmp(`${pgm} #${i + 1}`); shots++;
      const before = await bodyText();
      await clickEnter(); await sleep(1600);
      if ((await bodyText()) === before) break;
    }
    log(`  比較 ${shots} 画面`);
    if (!(await backToMenu())) { log("  メニューに戻れない → 中断"); break; }
  }
  await page.screenshot({ path: `${OUT}/webui-last.png` });
} catch (e) {
  log("ERROR: " + e.stack);
  await page.screenshot({ path: `${OUT}/webui-error.png` }).catch(() => {});
  process.exitCode = 1;
} finally {
  await browser.close();
  for (const e of sessions.list()) await sessions.close(e.id).catch(() => {});
  server.close();
}

writeFileSync(`${OUT}/findings.json`, JSON.stringify({ compared, findings }, null, 2));
log(`\n===== 比較した画面: ${compared} / 差異: ${findings.length} =====`);
const byKind = {};
for (const f of findings) byKind[f.kind] = (byKind[f.kind] ?? 0) + 1;
for (const [k, v] of Object.entries(byKind)) log(`  ${k}: ${v}`);
for (const f of findings.slice(0, 30)) log("  " + JSON.stringify(f));
