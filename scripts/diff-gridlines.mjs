// 罫線（GRDLIN / GRDATR）の位置・線種・色を、同じスナップショットから
// **web-ui** と **renderScreenHtml** の両方に描かせて 1 本ずつ実測比較する。
// あわせてホストが送ってきた生の値（minorType / value1 / value2 / lineStyle / color）も出す。
//
// 実行: AS400_USER=.. AS400_PASSWORD=.. node --env-file=.env --env-file=.env.verify scripts/diff-gridlines.mjs <出力先>
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { serve } from "@hono/node-server";
import { WebSocketServer } from "ws";
import { buildApp, SessionManager, ServerConfigStore, PersonalConfigStore, ConfigResolver } from "@ts5250/server";
import { renderScreenHtml, GRID_COLOR } from "@ts5250/tn5250";
import { SecretCrypto } from "../packages/server/dist/secret-crypto.js";
import { chromium } from "playwright";

const OUT = process.argv[2] ?? "gridline-diff";
mkdirSync(OUT, { recursive: true });
const PORT = 3514;
const LIB = process.env.AS400_LIB ?? "TESTLIB";
const PROGRAMS = ["GRIDCL", "GRIDCL2", "GRIDCL3", "GRIDCL4", "GRIDCL5", "GRIDCL6", "GRIDCL7", "EXTPGM"];

/** 原典（wdsf-parser.ts GRID_LINE_STYLE / Wireshark vals_tn5250_deg_lines と IBM DDS Table 15） */
const STYLE_NAME = {
  0x00: "solid", 0x01: "thick", 0x02: "double", 0x03: "dotted",
  0x08: "dashed", 0x09: "thick-dashed", 0x0a: "double-dashed", 0xff: "solid(既定)"
};

const log = (s) => process.stderr.write(s + "\n");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const cfg = JSON.parse(readFileSync("connections.json", "utf8"));
for (const sess of cfg.sessions) if (sess.name === (process.env.AS400_SESSION ?? "DEV1")) sess.deviceName = "";
const tmpCfg = `${OUT}/conn.json`;
writeFileSync(tmpCfg, JSON.stringify(cfg));

const crypto = SecretCrypto.fromEnv();
const resolver = new ConfigResolver(
  ServerConfigStore.fromFile(tmpCfg, crypto),
  new PersonalConfigStore({ systems: [], sessions: [] }, crypto)
);
const sessions = new SessionManager();
const app = buildApp({ sessions, resolver, version: "gl", webRoot: "packages/web-ui/dist" });
const wss = new WebSocketServer({ noServer: true });
const server = serve({ fetch: app.fetch, port: PORT, websocket: { server: wss } });
await sleep(600);

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
const page2 = await browser.newPage({ viewport: { width: 1600, height: 900 } });
const bodyText = () => page.locator("body").innerText();
const has = async (t) => (await bodyText()).includes(t);
const clickEnter = async () => {
  const b = page.getByText("⏎ 実行", { exact: false }).first();
  if (await b.count()) await b.click(); else await page.keyboard.press("Enter");
};
const pressF = async (n) => {
  const b = page.locator("button.fkey-btn", { hasText: new RegExp(`^F${n}\\b`) }).first();
  if (await b.count()) await b.click(); else await page.keyboard.press(`F${n}`);
};
const type = async (text) => {
  const inp = page.locator("input.grid-input").first();
  await inp.click(); await page.keyboard.press("Home");
  await page.keyboard.type(text, { delay: 20 });
};

/** web-ui 側の罫線を測る（原点＝1 行目、桁幅＝ruler の 1/10） */
function measureWebui() {
  const rows = [...document.querySelectorAll(".grid .grid-row")];
  if (rows.length === 0) return [];
  const o = rows[0].getBoundingClientRect();
  const chW = document.querySelector(".cell-ruler").getBoundingClientRect().width / 10;
  const rowH = o.height;
  const styleOf = (cl) => {
    const has = (x) => cl.includes(x);
    if (has("gl-dashed") && has("gl-thick")) return "thick-dashed";
    if (has("gl-dashed")) return "dashed";
    if (has("gl-dotted")) return "dotted";
    if (has("gl-double")) return "double";
    if (has("gl-thick")) return "thick";
    return "solid";
  };
  return [...document.querySelectorAll(".grid .grid-line")].map((el) => {
    const r = el.getBoundingClientRect();
    const cl = [...el.classList];
    const color = (cl.find((x) => x.startsWith("c-")) ?? "c-?").slice(2);
    const horizontal = cl.includes("grid-h");
    return horizontal
      ? { o: "h", at: Math.round((r.top - o.top) / rowH), from: Math.round((r.left - o.left) / chW), len: Math.round(r.width / chW), color, style: styleOf(cl) }
      : { o: "v", at: Math.round((r.left - o.left) / chW), from: Math.round((r.top - o.top) / rowH), len: Math.round(r.height / rowH), color, style: styleOf(cl) };
  });
}

/** renderScreenHtml 側の罫線を測る（原点＝1 行目、桁幅＝grid 幅 / 桁数） */
function measureHtml(cols) {
  const lns = [...document.querySelectorAll(".grid .ln")];
  if (lns.length === 0) return [];
  const o = lns[0].getBoundingClientRect();
  const grid = document.querySelector(".grid");
  const chW = grid.getBoundingClientRect().width / cols;
  const rowH = o.height;
  // 修正後は screen-html も web-ui と同じクラス名（gl-dotted / gl-dashed / …）を使う。
  // classList は配列なので includes は完全一致——部分一致のつもりで書くと全部 solid になる。
  const styleOf = (cl) => {
    const has = (x) => cl.includes(x);
    if (has("gl-dashed") && has("gl-thick")) return "thick-dashed";
    if (has("gl-dashed")) return "dashed";
    if (has("gl-dotted")) return "dotted";
    if (has("gl-double")) return "double";
    if (has("gl-thick")) return "thick";
    return "solid";
  };
  return [...document.querySelectorAll(".grid .gl")].map((el) => {
    const r = el.getBoundingClientRect();
    const cl = [...el.classList];
    const color = (cl.find((x) => x.startsWith("c-")) ?? "c-?").slice(2);
    const horizontal = cl.includes("gl-h");
    return horizontal
      ? { o: "h", at: Math.round((r.top - o.top) / rowH), from: Math.round((r.left - o.left) / chW), len: Math.round(r.width / chW), color, style: styleOf(cl) }
      : { o: "v", at: Math.round((r.left - o.left) / chW), from: Math.round((r.top - o.top) / rowH), len: Math.round(r.height / rowH), color, style: styleOf(cl) };
  });
}

const key = (l) => `${l.o}@${l.at} ${l.from}+${l.len} ${l.color}/${l.style}`;
const report = [];

try {
  await page.goto(`http://localhost:${PORT}/`);
  await page.waitForSelector(".launcher", { timeout: 20000 });
  await page.click(".card:has-text('実機') >> button:has-text('選択')");
  await page.waitForSelector(".card:has-text('DEV1')", { timeout: 10000 });
  await page.click(".card:has-text('DEV1') >> button:has-text('接続')");
  await page.waitForFunction(() => document.querySelectorAll(".grid .grid-row").length > 0, { timeout: 25000 });
  await sleep(900);
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
    await type(`CALL ${LIB}/${pgm}`); await clickEnter(); await sleep(1900);
    for (let f = 0; f < 4; f++) {
      if (await has("メインメニュー")) break;
      const snap = sessions.list()[0].session.snapshot();
      const items = snap.gui?.gridLines ?? [];
      if (items.length > 0) {
        const web = await page.evaluate(measureWebui);
        await page2.setContent(renderScreenHtml(snap, { title: "cmp" }));
        await page2.waitForSelector(".grid .ln");
        const html = await page2.evaluate(measureHtml, snap.cols);

        const wk = web.map(key).sort();
        const hk = html.map(key).sort();
        const onlyWeb = wk.filter((k) => !hk.includes(k));
        const onlyHtml = hk.filter((k) => !wk.includes(k));
        report.push({
          screen: `${pgm} #${f + 1}`,
          hostItems: items.map((g) => ({
            row: g.row, col: g.col, w: g.width, h: g.height,
            minorType: "0x" + g.minorType.toString(16).padStart(2, "0"),
            v1: g.value1, v2: g.value2,
            color: `0x${g.color.toString(16)}→${GRID_COLOR[g.color] ?? "white"}`,
            lineStyle: `0x${g.lineStyle.toString(16).padStart(2, "0")}→${STYLE_NAME[g.lineStyle] ?? "?"}`
          })),
          counts: { webui: web.length, html: html.length },
          onlyWeb, onlyHtml
        });
        log(`${pgm} #${f + 1}: 罫線 ${items.length} 件 → web-ui ${web.length} 本 / html ${html.length} 本, 差 web専用${onlyWeb.length} html専用${onlyHtml.length}`);
      }
      const before = await bodyText();
      await clickEnter(); await sleep(1500);
      if ((await bodyText()) === before) break;
    }
    if (!(await backToMenu())) break;
  }
} catch (e) {
  log("ERROR: " + e.stack);
  process.exitCode = 1;
} finally {
  await browser.close();
  for (const e of sessions.list()) await sessions.close(e.id).catch(() => {});
  server.close();
}

writeFileSync(`${OUT}/gridlines.json`, JSON.stringify(report, null, 2));
log("\n===== 罫線の照合 =====");
for (const r of report) {
  log(`\n■ ${r.screen}  web-ui ${r.counts.webui} 本 / html ${r.counts.html} 本`);
  for (const g of r.hostItems) log(`   host: ${JSON.stringify(g)}`);
  if (r.onlyWeb.length === 0 && r.onlyHtml.length === 0) log("   → 一致");
  else {
    for (const k of r.onlyWeb.slice(0, 8)) log(`   web-ui のみ: ${k}`);
    for (const k of r.onlyHtml.slice(0, 8)) log(`   html のみ  : ${k}`);
  }
}
