// **ログパネルが画面の中の重ねものより上に来るか**を実ブラウザで確かめる
// （`20260802-chrome-icon-polish`）。
//
// 直す前は option の▾（`.opt-btn`、z-index 6）がログパネル（5）の上に透けていた。
// 直しは「パネル側を 10 に上げる」だけだが、**それで足りるかは重なりの土俵次第**
// ——間の祖先がスタッキングコンテキストを作っていれば数の大小は無意味になる。
// そこを机上でなく実物で確かめるのがこのスクリプト。
//
// option の▾を出すには Opt 欄のある画面まで運転が要るので、**同じ性質の代役**を使う:
// `.grid` の中に `position:absolute; z-index:7`（画面内の最大＝`.opt-hints` と同じ）の
// 板をログパネルの上に重ねて置き、`elementFromPoint` がどちらを返すかを見る。
// 板が返ればログパネルが負けている＝直っていない。
//
// 実行: node --env-file=.env --env-file=.env.verify scripts/verify-logpanel-stack.mjs
//   （事前に `npm run build` と `npm run build -w @ts5250/web-ui` が要る）
//
// 副作用: 実機へ表示セッションを 1 本張って画面を読むだけ。装置名は指定せずホストに採らせる。
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
const PORT = Number(process.env.PORT ?? 3490);

const log = (s) => process.stdout.write(s + "\n");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0;
let fail = 0;
const check = (cond, msg) => {
  if (cond) { pass++; log(`  PASS ${msg}`); } else { fail++; log(`  FAIL ${msg}`); }
};

const work = mkdtempSync(join(tmpdir(), "logstack-"));
const cfgPath = join(work, "profiles.json");
// **パスワードはファイルに書かない**——`passwordEnv` で環境変数を指す
writeFileSync(
  cfgPath,
  JSON.stringify({
    systems: [{ id: "AS400", name: "AS400", host, ccsid: 5035, signon: { user, passwordEnv: "AS400_PASSWORD" } }],
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

try {
  await page.goto(`http://127.0.0.1:${PORT}/`);
  await page.waitForSelector(".launcher", { timeout: 15_000 });
  const pick = page.locator(".card", { hasText: "AS400" }).first().locator("button", { hasText: "選択" });
  if (await pick.count()) { await pick.click(); await sleep(400); }
  await page.locator(".card", { hasText: "DSP" }).first().locator("button", { hasText: /^(接続|開く)$/ }).click();
  await page.waitForFunction(() => (document.querySelector(".grid")?.textContent?.length ?? 0) > 400, { timeout: 40_000 });
  await sleep(1500);

  // ---- ログパネルを開く（フッターのトグル） ----
  log("### ログパネルを開く");
  await page.locator(".oia .logbtn").click();
  await page.waitForSelector(".logpanel", { timeout: 10_000 });
  await sleep(400);
  check(true, "ログパネルが開く");

  // ---- 画面内の重ねもの（z-index 7 相当）と重なり順を比べる ----
  log("\n### 画面の中の重ねものより上か");
  const r = await page.evaluate(() => {
    const grid = document.querySelector(".grid");
    const panel = document.querySelector(".logpanel");
    if (!grid || !panel) return { error: ".grid か .logpanel が無い" };

    /**
     * `.grid` と `.logpanel` が**同じ土俵**に居るか（間にスタッキングコンテキストが無いか）。
     * どちらかが別の文脈に入っていると、z-index の大小は比べる意味を失う。
     */
    const makesContext = (el) => {
      const s = getComputedStyle(el);
      if (s.position !== "static" && s.zIndex !== "auto") return true;
      if (s.isolation === "isolate") return true;
      if (s.transform !== "none" || s.filter !== "none" || s.perspective !== "none") return true;
      if (s.mixBlendMode !== "normal" || s.opacity !== "1") return true;
      if (s.contain.includes("paint") || s.contain.includes("layout")) return true;
      return false;
    };
    const between = [];
    for (let el = grid.parentElement; el && el !== document.documentElement; el = el.parentElement) {
      if (el.contains(panel)) break; // 共通の祖先まで来た
      if (makesContext(el)) between.push(el.className);
    }

    // 画面の中の最大（`.opt-hints`）と同じ高さの板を、ログパネルに重なる位置へ置く
    const pr = panel.getBoundingClientRect();
    const probe = document.createElement("div");
    probe.id = "stack-probe";
    Object.assign(probe.style, {
      position: "absolute", zIndex: "7",
      left: "0px", top: "0px", width: "40px", height: "20px"
    });
    grid.appendChild(probe);
    // 画面座標で板をログパネルの中央へ持っていく（grid の padding box 基準の差分で寄せる）
    const br = probe.getBoundingClientRect();
    const x = pr.left + pr.width / 2;
    const y = pr.top + pr.height / 2;
    probe.style.left = `${x - br.left - 20}px`;
    probe.style.top = `${y - br.top - 10}px`;

    const hitTag = document.elementFromPoint(x, y);
    const hitProbe = hitTag === probe || probe.contains(hitTag);
    const inPanel = panel.contains(hitTag);
    probe.remove();
    return {
      between,
      panelZ: getComputedStyle(panel).zIndex,
      gridZ: getComputedStyle(grid).zIndex,
      hitProbe,
      inPanel,
      hit: hitTag ? `${hitTag.tagName.toLowerCase()}.${hitTag.className}` : "(なし)"
    };
  });
  if (r.error) throw new Error(r.error);

  check(
    r.between.length === 0,
    `\`.grid\` と \`.logpanel\` が同じ土俵に居る（間のスタッキングコンテキスト: ${r.between.length ? r.between.join(" / ") : "無し"}）`
  );
  check(r.panelZ === "10", `ログパネルの z-index が 10（実際 ${r.panelZ}）`);
  check(r.gridZ === "auto", `\`.grid\` は z-index:auto のまま（中の重ねものがこの土俵へ出る前提。実際 ${r.gridZ}）`);
  check(!r.hitProbe, `**画面の中の重ねもの（z-index 7）がログの上に出ない**（当たったのは ${r.hit}）`);
  check(r.inPanel, "同じ点でログパネルの中身が拾える（＝パネルが手前）");
} catch (e) {
  fail++;
  log(`  FAIL 例外: ${e?.message ?? e}`);
  try {
    const t = await page.locator("body").innerText();
    log("  --- 画面 ---\n" + t.split("\n").slice(0, 25).map((l) => "  | " + l).join("\n"));
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
