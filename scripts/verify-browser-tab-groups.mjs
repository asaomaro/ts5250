// タブグループの**見た目の不変条件**を実ブラウザで実測する（`20260804-tab-groups`）。
//
// 検証するのは 1 点だけ——**タブグループを作ってもタブ帯が高くならない**こと。
// タブ帯の行高はヘッダーと共有の `--chrome-row-h`（28px）で、削ってエミュレータ画面に
// 回した経緯がある（`PaneTabs.vue`「ACS 相当の余白に」）。グループの装飾で border / padding /
// outline を足すと 1 行ぶん背が伸びるため、**枠で囲わず背景と inset の影だけ**で表している。
//
// **jsdom では検証できない**（`<style scoped>` を適用せず、レイアウトも計算しない）ので、
// 単体テスト側は CSS の宣言を走査して規約を固定するに留めてある
// （`packages/web-ui/test/tab-group-ui.test.ts`）。実寸はここで担保する。
//
// **ホストへの接続は不要**（verify-browser-* の中では例外的に IBM i を要らない）。
// ビルド済みの CSS を素の HTML に当てて測るだけ。
//
// 前提: `npm run build -w @ts5250/web-ui` 済み。
// 実行: node scripts/verify-browser-tab-groups.mjs
import { chromium } from "playwright";
import { readdirSync, readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const DIST = "packages/web-ui/dist/assets";
const css = readdirSync(DIST).find((f) => f.endsWith(".css"));
if (!css) {
  console.error("ビルド済み CSS が見つかりません。npm run build -w @ts5250/web-ui を先に実行してください");
  process.exit(1);
}
const cssText = readFileSync(join(DIST, css), "utf8");

// scoped スタイルの属性（`data-v-xxxxxxxx`）を実物から拾う——手で書くとビルドのたびにずれる
const hash = /\.tg-chip\[(data-v-[a-z0-9]+)\]/.exec(cssText)?.[1];
if (!hash) {
  console.error("PaneTabs の scoped スタイルが CSS に見つかりません");
  process.exit(1);
}

/** タブ 1 枚のマークアップ（`PaneTabs.vue` のテンプレートと同じ構造） */
const tab = (label, cls = "", style = "") =>
  `<div class="tab ${cls}" ${hash} style="${style}">` +
  `<span class="dot" ${hash}></span>${label}` +
  `<button class="x" ${hash}>✕</button></div>`;

const page = (body) => `<!doctype html>
<html data-theme="dark"><head><meta charset="utf-8"><link rel="stylesheet" href="./${css}"></head>
<body style="margin:0;background:var(--crt)">${body}</body></html>`;

// 1) グループなし  2) グループあり（チップ＋メンバー 2 枚）
const plain = `<div id="a" class="tabs" ${hash}>${tab("SQL")}${tab("IFS")}${tab("監視")}</div>`;
const grouped =
  `<div id="b" class="tabs" ${hash}>` +
  `<div class="tg-chip" ${hash} style="--tg: var(--tg-3)"><span class="tg-name" ${hash}>検証作業</span>` +
  `<button class="tg-fold" ${hash}>∨</button></div>` +
  tab("SQL", "tg-member tg-first", "--tg: var(--tg-3)") +
  tab("IFS", "tg-member tg-last", "--tg: var(--tg-3)") +
  tab("監視") +
  `</div>`;

const dir = mkdtempSync(join(tmpdir(), "tg-"));
writeFileSync(join(dir, css), cssText);
writeFileSync(join(dir, "index.html"), page(plain + grouped));

const browser = await chromium.launch();
const p = await browser.newPage({ viewport: { width: 1000, height: 200 } });
await p.goto(`file://${join(dir, "index.html")}`);

const m = await p.evaluate(() => {
  const h = (id) => document.getElementById(id).getBoundingClientRect().height;
  const chip = document.querySelector(".tg-chip").getBoundingClientRect();
  const member = document.querySelector(".tab.tg-member").getBoundingClientRect();
  const plainTab = document.querySelector("#a .tab").getBoundingClientRect();
  return { plain: h("a"), grouped: h("b"), chip: chip.height, member: member.height, tab: plainTab.height };
});
await p.screenshot({ path: join(dir, "tab-groups.png") });
await browser.close();

const rows = [
  ["タブ帯（グループなし）", m.plain],
  ["タブ帯（グループあり）", m.grouped],
  ["タブ 1 枚（グループ外）", m.tab],
  ["タブ 1 枚（メンバー）", m.member],
  ["チップ", m.chip]
];
for (const [k, v] of rows) console.log(`${k.padEnd(24)} ${v.toFixed(2)}px`);

const fail = [];
if (m.grouped !== m.plain) fail.push(`タブ帯が高くなった: ${m.plain} → ${m.grouped}`);
if (m.member !== m.tab) fail.push(`メンバータブの高さが変わった: ${m.tab} → ${m.member}`);
if (m.plain !== 28) fail.push(`タブ帯が 28px（--chrome-row-h）でない: ${m.plain}`);
if (m.chip > m.plain) fail.push(`チップが行高を超えた: ${m.chip} > ${m.plain}`);

console.log(`\nスクリーンショット: ${join(dir, "tab-groups.png")}`);
if (fail.length > 0) {
  console.error("\nRESULT: FAIL");
  for (const f of fail) console.error(`  - ${f}`);
  process.exit(1);
}
console.log("\nRESULT: PASS（グループの有無でタブ帯の高さが変わらない）");
