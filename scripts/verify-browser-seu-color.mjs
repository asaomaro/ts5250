// 実ブラウザで SEU の埋め込み色属性を検証する E2E。
// build 済み web-ui を server で配信し、実 5250 セッションで MYLIB/QTESTSRC を SEU 編集し、
// 入力欄の色付きオーバーレイ（赤/緑）が実際に描画されることを getComputedStyle で確かめる。
// 前提: npm run build -w @ts5250/web-ui 済み。MYLIB/QTESTSRC(COLORTEST) に埋め込み属性行あり。
// 実行: node --env-file=.env scripts/verify-browser-seu-color.mjs
import { serve } from "@hono/node-server";
import { WebSocketServer } from "ws";
import { buildApp, SessionManager, ServerConfigStore, PersonalConfigStore, ConfigResolver } from "@ts5250/server";
import { SecretCrypto } from "../packages/server/dist/secret-crypto.js";
import { chromium } from "playwright";
import { readFileSync } from "node:fs";

const results = [];
const check = (n, ok, d="") => { results.push({n,ok,d}); process.stdout.write(`${ok?"OK  ":"NG  "} ${n}${d?` — ${d}`:""}\n`); };

async function main() {
  const raw = JSON.parse(readFileSync("profiles.local.json", "utf8"));
  const crypto = SecretCrypto.fromEnv();
  const resolver = new ConfigResolver(
    new ServerConfigStore({ systems: raw.systems, sessions: raw.sessions }, crypto),
    new PersonalConfigStore({ systems: [], sessions: [] }, crypto)
  );
  const app = buildApp({ sessions: new SessionManager(), resolver, version: "e2e", webRoot: "packages/web-ui/dist" });
  const port = 3466;
  const wss = new WebSocketServer({ noServer: true });
  const server2 = serve({ fetch: app.fetch, port, websocket: { server: wss } });

  const browser = await chromium.launch();
  const page = await browser.newPage();
  page.on("console", (m) => { if (m.type()==="error") process.stdout.write(`  [console] ${m.text()}\n`); });
  try {
    await page.goto(`http://localhost:${port}/`);
    // セッション "pub400" の接続ボタンを押す（システムは自動選択）
    await page.waitForSelector(".card", { timeout: 20000 });
    const card = page.locator(".card", { hasText: "pub400" }).first();
    await card.locator("button", { hasText: /接続|開く/ }).first().click();
    // エミュレーター画面
    await page.waitForSelector(".grid", { timeout: 30000 });
    check("エミュレーターが開く", true);

    const screenText = () => page.evaluate(() => document.querySelector(".grid")?.textContent ?? "");
    const waitText = async (t, ms=30000) => { await page.waitForFunction((tt)=>(document.querySelector(".grid")?.textContent??"").includes(tt), t, { timeout: ms }).catch(()=>{}); };

    // サインオン後、メッセージ画面や MAIN メニューへ。Enter で進める
    await page.locator(".grid").click();
    for (let i=0;i<3;i++){
      const txt = await screenText();
      if (txt.includes("Main Menu")||txt.includes("Selection or command")) break;
      await page.keyboard.press("Enter");
      await page.waitForTimeout(1500);
    }
    await waitText("Selection or command", 30000);
    check("メインメニューに到達", (await screenText()).includes("Selection or command"));

    // コマンド行に STRSEU を入力して Enter
    // コマンド入力欄（グリッド入力）をクリックして打鍵
    const cmd = "STRSEU SRCFILE(TESTLIB/QTESTSRC) SRCMBR(COLORTEST) OPTION(2)";
    // 一番下の入力欄にフォーカス。command line は最後の grid-input のことが多い
    const inputs = page.locator("input.grid-input");
    const n = await inputs.count();
    process.stdout.write(`  grid-input 数=${n}\n`);
    await inputs.first().click();
    await page.keyboard.type(cmd, { delay: 10 });
    await page.waitForTimeout(300);
    process.stdout.write(`  入力後の先頭input値=${JSON.stringify(await inputs.first().inputValue())}\n`);
    await page.keyboard.press("Enter");
    await waitText("Columns", 30000);
    await waitText("COMMENT", 30000);
    const seuTxt = await screenText();
    if (!seuTxt.includes("COMMENT")) process.stdout.write(`  --- 画面 ---\n${seuTxt.slice(0,600)}\n`);
    check("SEU で COLORTEST を開く", seuTxt.includes("COMMENT"));

    // COMMENT の行の入力欄にオーバーレイが付き、赤/緑が実際に描画されているか
    const colors = await page.evaluate(() => {
      const overlays = [...document.querySelectorAll(".input-overlay")];
      for (const ov of overlays) {
        const txt = ov.textContent ?? "";
        if (txt.includes("COMMENT") && txt.includes("RED") && txt.includes("GREEN")) {
          const spans = [...ov.querySelectorAll("span")].map((s) => ({
            text: s.textContent, color: getComputedStyle(s).color, cls: s.className
          }));
          return { found: true, spans };
        }
      }
      return { found: false, overlays: overlays.map(o=>o.textContent) };
    });
    check("COMMENT 行にオーバーレイが付く", colors.found, colors.found?"":JSON.stringify(colors).slice(0,200));
    if (colors.found) {
      const distinct = new Set(colors.spans.map((s)=>s.color));
      check("欄内で複数の色が実描画される", distinct.size >= 2, colors.spans.map(s=>`${(s.text||"").trim().slice(0,6)}:${s.color}`).join(" / "));
      const hasRed = colors.spans.some((s)=>/RED/.test(s.text||"") && s.cls.includes("c-red"));
      const hasGreen = colors.spans.some((s)=>/GREEN/.test(s.text||"") && s.cls.includes("c-green"));
      check("RED は c-red / GREEN は c-green", hasRed && hasGreen, `red=${hasRed} green=${hasGreen}`);
    }

    // バグ1 検証: COMMENT 行にカーソルを入れて横移動 → Enter 送信 → 色が消えないこと。
    // （カーソル移動で変更扱いにしていた頃は、送信で SEU が行を書き戻し属性バイトが空白化＝色が消えた）
    if (colors.found) {
      // 値に COMMENT を含む入力欄へフォーカスしてカーソルを置く
      await page.evaluate(() => {
        const inputs = [...document.querySelectorAll("input.grid-input")];
        const el = inputs.find((i) => (i.value || "").includes("COMMENT"));
        if (el) { el.focus(); el.setSelectionRange(2, 2); }
      });
      await page.keyboard.press("ArrowRight");
      await page.keyboard.press("ArrowRight");
      await page.keyboard.press("Enter");
      await page.waitForTimeout(2000);
      const after = await page.evaluate(() => {
        const ov = [...document.querySelectorAll(".input-overlay")].find((o) => {
          const t = o.textContent ?? ""; return t.includes("COMMENT") && t.includes("RED") && t.includes("GREEN");
        });
        if (!ov) return { ok: false };
        const reds = [...ov.querySelectorAll("span")].filter((s) => getComputedStyle(s).color === "rgb(198, 40, 40)");
        return { ok: reds.length > 0 };
      });
      check("カーソル移動+送信の後も色が残る（変更扱いにしない）", after.ok);

      // フォーカス中はオーバーレイを隠し入力欄の文字を見せる／非フォーカスで色付き復元
      const focusState = await page.evaluate(() => {
        const inputs = [...document.querySelectorAll("input.grid-input")];
        const el = inputs.find((i) => (i.value || "").includes("COMMENT"));
        if (!el) return { ok: false };
        el.focus();
        const wrap = el.closest(".input-cell");
        const ov = wrap?.querySelector(".input-overlay");
        const focusedTextVisible = getComputedStyle(el).color !== "rgba(0, 0, 0, 0)" &&
          getComputedStyle(el).color !== "transparent";
        const overlayHiddenOnFocus = !ov || getComputedStyle(ov).display === "none";
        el.blur();
        const overlayShownOnBlur = ov && getComputedStyle(ov).display !== "none" &&
          (getComputedStyle(el).color === "rgba(0, 0, 0, 0)" || getComputedStyle(el).color === "transparent");
        return { ok: focusedTextVisible && overlayHiddenOnFocus && overlayShownOnBlur,
          focusedTextVisible, overlayHiddenOnFocus, overlayShownOnBlur };
      });
      check("フォーカス中は文字が見え・非フォーカスで色復元", focusState.ok, JSON.stringify(focusState));
    }

    // 後片付け: SEU を F3 で抜ける（保存しない）
    await page.keyboard.press("F3");
    await page.waitForTimeout(1500);
    await page.keyboard.press("Enter");
  } finally {
    await browser.close();
    server2.close?.();
    wss.close();
  }
  const failed = results.filter(r=>!r.ok);
  process.stdout.write(`\n${results.length-failed.length}/${results.length} 成功\n`);
  process.exit(failed.length?1:0);
}
main().catch((e)=>{ process.stderr.write(`${e?.stack??e}\n`); process.exit(1); });
