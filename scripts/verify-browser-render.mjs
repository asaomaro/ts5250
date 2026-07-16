// 実ブラウザでの描画回帰 E2E（属性の見た目）。build 済み web-ui を server で配信し、
// Playwright で DBCS プロファイル（CCSID 1399）へ接続 → CLRTPGM を CALL し、幾何/計算スタイルで:
//   1) 反転(背景色)セルの文字色 ≠ 背景色（＝文字が見える。旧 bug: 文字色＝背景色で不可視）
//   2) DBCS(全角)セルの上端が同一行の SBCS テキストと揃う（旧 bug: 全角が約 5px 上へずれる）
// を検証する。jsdom では描画を検証できないためブラウザで担保する。
// 前提: npm run build 済み。profiles.local.json に CCSID 1399 プロファイル。CLRTPGM は build-attrtest.mjs で作成。
// 実行: node --env-file=.env scripts/verify-browser-render.mjs
import { serve } from "@hono/node-server";
import { WebSocketServer } from "ws";
import { buildApp, SessionManager, ProfileStore } from "@as400web/server";
import { chromium } from "playwright";

const log = (s) => process.stderr.write(s + "\n");
const LIB = process.env.PUB400_LIB ?? "MYLIB";
const PORT = 3468;

const sessions = new SessionManager();
const profiles = ProfileStore.fromFile("profiles.local.json");
const app = buildApp({ sessions, profiles, version: "test", webRoot: "packages/web-ui/dist" });
const wss = new WebSocketServer({ noServer: true });
const server = serve({ fetch: app.fetch, port: PORT, websocket: { server: wss } });
await new Promise((r) => setTimeout(r, 500));

const jp = (await (await fetch(`http://localhost:${PORT}/api/profiles`)).json()).profiles.find((p) => p.ccsid === 1399);
if (!jp) { log("NG — CCSID 1399 プロファイルが必要"); server.close?.(); process.exit(1); }

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1100, height: 700 } });
let ok = true;
const check = (name, cond, d = "") => { log(`${cond ? "PASS" : "FAIL"}  ${name}${d ? "  — " + d : ""}`); ok = ok && cond; };
try {
  await page.goto(`http://localhost:${PORT}/`);
  await page.locator("button.card", { hasText: jp.name }).first().click();
  await page.waitForFunction(() => document.querySelector(".grid")?.textContent?.includes("Main Menu"), { timeout: 20000 });
  const cmd = page.locator("input.grid-input").first();
  await cmd.click(); await page.keyboard.type(`CALL ${LIB}/CLRTPGM`); await page.keyboard.press("Enter");
  await page.waitForFunction(() => document.querySelector(".grid")?.textContent?.includes("ATTR TEST"), { timeout: 20000 });
  log("CLRTPGM 表示");

  // 1) 反転セル（RVS）の文字色 ≠ 背景色
  const rvs = await page.evaluate(() => {
    const span = [...document.querySelectorAll(".grid-span.a-reverse")].find((e) => e.textContent.includes("RVS"));
    if (!span) return null;
    const s = getComputedStyle(span);
    return { color: s.color, bg: s.backgroundColor };
  });
  check("反転セルが存在する", !!rvs);
  check("反転セル: 文字色 ≠ 背景色（文字が見える）", rvs && rvs.color !== rvs.bg, rvs && `color=${rvs.color} bg=${rvs.bg}`);
  check("反転セル: 背景が透明でない（背景色が付く）", rvs && rvs.bg !== "rgba(0, 0, 0, 0)" && rvs.bg !== "transparent", rvs && rvs.bg);

  // 2) DBCS(全角)の上端が同一行 SBCS テキストと揃う（±3px）
  const align = await page.evaluate(() => {
    const dbcs = document.querySelector(".grid-dbcs");
    if (!dbcs) return null;
    const row = dbcs.closest(".grid-row");
    const sbcs = [...row.querySelectorAll(".grid-span")].find((e) => !e.classList.contains("grid-dbcs") && e.textContent.trim());
    if (!sbcs) return null;
    return { dbcsTop: dbcs.getBoundingClientRect().top, sbcsTop: sbcs.getBoundingClientRect().top };
  });
  check("DBCS セルが存在する", !!align);
  const dy = align ? Math.abs(align.dbcsTop - align.sbcsTop) : 99;
  check("DBCS の上端が同一行テキストと揃う（±3px）", dy <= 3, `Δtop=${dy.toFixed(1)}px`);

  await page.keyboard.press("F3").catch(() => {});
} catch (e) {
  ok = false; log("BROWSER E2E ERROR: " + e.message);
} finally {
  await browser.close();
  server.close?.();
}
log(ok ? "\nOK — 反転(背景色)＋DBCS 縦位置の描画が正しい" : "\nNG");
process.exit(ok ? 0 : 1);
