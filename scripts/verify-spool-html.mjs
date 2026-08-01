// renderSpoolHtml の出力を実ブラウザで開き、**各行の描画幅が桁数と一致するか**を実測する。
// 帳票は桁が命なので、全角が 2 桁ぶんの箱に入っていることを px で確かめる。
//
// 実行: node scripts/verify-spool-html.mjs <html> <pages.json>
import { readFileSync } from "node:fs";
import { chromium } from "playwright";
import { isFullWidth } from "@as400web/base";

const HTML = process.argv[2];
const PAGES = process.argv[3];
const log = (s) => process.stderr.write(s + "\n");

const pages = JSON.parse(readFileSync(PAGES, "utf8"));
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1900, height: 1000 } });
try {
  await page.setContent(readFileSync(HTML, "utf8"));
  await page.waitForSelector("figure.pg");

  // 印刷時と同じく全ページを見せてから測る（既定では 1 ページ目以外 hidden）
  await page.evaluate(() => {
    document.querySelectorAll("figure.pg").forEach((f) => (f.hidden = false));
  });

  const measured = await page.evaluate(() => {
    // 桁幅は等幅 ASCII の実測から出す（sheet と同じフォント・サイズで測る）
    const sheet = document.querySelector(".sheet");
    const probe = document.createElement("span");
    probe.textContent = "0".repeat(50);
    probe.style.whiteSpace = "pre";
    sheet.appendChild(probe);
    const chW = probe.getBoundingClientRect().width / 50;
    probe.remove();
    return [...document.querySelectorAll("figure.pg")].map((fig) => ({
      lines: [...fig.querySelectorAll(".ln")].map((ln) => {
        const r = ln.getBoundingClientRect();
        // 行の中身の右端 = 最後の子の右端（.ln は幅いっぱいに伸びるため子から測る）
        const kids = [...ln.childNodes];
        let right = r.left;
        for (const k of kids) {
          const range = document.createRange();
          range.selectNodeContents(k);
          const rr = (k.nodeType === 1 ? k.getBoundingClientRect() : range.getBoundingClientRect());
          if (rr.right > right) right = rr.right;
        }
        return Math.round((right - r.left) / chW);
      }),
      wide: fig.querySelectorAll("span.w").length
    }));
  });

  let bad = 0, total = 0, wideTotal = 0;
  pages.pages.forEach((p, pi) => {
    const m = measured[pi];
    wideTotal += m.wide;
    p.lines.forEach((line, li) => {
      // 期待桁数: 全角は 2 桁（末尾の空白は落ちているので trimEnd 済み前提）
      let cols = 0;
      for (const ch of line) cols += isFullWidth(ch) ? 2 : 1;
      const got = m.lines[li];
      total++;
      if (Math.abs(got - cols) > 1) { // 丸め 1 桁は許容
        bad++;
        if (bad <= 5) log(`  ページ${pi + 1} 行${li + 1}: 期待 ${cols} 桁 / 実測 ${got} 桁\n     ${JSON.stringify(line.slice(0, 60))}`);
      }
    });
  });
  log(`\n照合: ${total} 行 / 桁ずれ ${bad} 行 / 全角の箱 ${wideTotal} 個`);
  log(bad === 0 ? "→ 全行で桁が一致" : "→ 桁ずれあり");
  process.exitCode = bad === 0 ? 0 : 1;
} catch (e) {
  log("ERROR: " + e.stack);
  process.exitCode = 1;
} finally {
  await browser.close();
}
