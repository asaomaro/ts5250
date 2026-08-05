// タブグループの**見た目の不変条件**を実ブラウザで実測する（`20260804-tab-groups`）。
//
// 検証するのは 2 点。
//
// 1. **タブグループを作ってもタブ帯が高くならない**こと。
// タブ帯の行高はヘッダーと共有の `--chrome-row-h`（28px）で、削ってエミュレータ画面に
// 回した経緯がある（`PaneTabs.vue`「ACS 相当の余白に」）。グループの装飾で border / padding /
// outline を足すと 1 行ぶん背が伸びるため、**枠で囲わず背景と inset の影だけ**で表している。
//
// 2. **チップとメンバータブがひと続きに見える**こと（ブラウザのタブグループと同じ。利用者の指摘）。
//    以前はチップだけ小さい丸ピルで `gap: 2px` を挟んで浮いており、別部品に見えていた。
//    「隙間 0」「チップとタブが同じ高さ」を実測で固定する——CSS の書き方は何通りもあるが、
//    利用者が見ているのは**出来上がりの寸法**なので、そこを押さえる。
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

/**
 * タブ 1 枚のマークアップ（`PaneTabs.vue` のテンプレートと同じ構造）。
 *
 * **接続ランプ（`.dot`）は描かない**——ここで並べるのはアプリ系タブ（SQL・IFS・監視）で、
 * それらにはランプを出さないため（`PaneTabs.vue` の `v-if="!isPane(...)"`）。
 */
const tab = (label, cls = "", style = "") =>
  `<div class="tab ${cls}" ${hash} style="${style}">${label}` +
  `<button class="x" ${hash}>✕</button></div>`;
/** run（ひと続き）の器。グループ外のタブも 1 枚だけの run で包む（テンプレートと同じ） */
const run = (inner, cls = "", style = "") =>
  `<div class="tg-run ${cls}" ${hash} style="${style}">${inner}</div>`;
/** タブグループのチップ（角丸四角のボタン） */
const chip = (name, fold) =>
  `<div class="tg-chip" ${hash}><span class="tg-name" ${hash}>${name}</span>` +
  `<button class="tg-fold" ${hash}>${fold}</button></div>`;

const page = (body) => `<!doctype html>
<html data-theme="dark"><head><meta charset="utf-8"><link rel="stylesheet" href="./${css}"></head>
<body style="margin:0;background:var(--crt)">${body}</body></html>`;

const TG3 = "--tg: var(--tg-3)";
/**
 * システムカラーの帯（下端）。**グループの線（上端）と同時に出せるか**を絵で確かめる
 * ——上＝どのグループか / 下＝どのシステムか、と辺で軸を割っている。
 */
const SYS = "--tab-sys: var(--sys-1)";

// 1) グループなし  2) グループあり（チップ＋メンバー 2 枚）
const plain =
  `<div id="a" class="tabs" ${hash}>` +
  run(tab("SQL", "", SYS)) +
  run(tab("IFS", "", SYS)) +
  run(tab("監視")) +
  `</div>`;
const grouped =
  `<div id="b" class="tabs" ${hash}>` +
  run(
    chip("検証作業", "∨") +
      tab("SQL", "tg-member tg-first on", `${TG3}; ${SYS}`) + // 選択中のメンバー（濃く塗る）
      tab("IFS", "tg-member tg-last", `${TG3}; ${SYS}`),
    "grouped",
    TG3
  ) +
  run(tab("監視")) +
  `</div>`;

// 3) 折りたたみ中（チップだけが残る。結ぶ相手が居ないので線は引かない）
const collapsed =
  `<div id="c" class="tabs" ${hash}>` +
  run(chip("片付け中", "›"), "grouped collapsed", "--tg: var(--tg-4)") +
  run(tab("監視")) +
  `</div>`;

const dir = mkdtempSync(join(tmpdir(), "tg-"));
writeFileSync(join(dir, css), cssText);
writeFileSync(join(dir, "index.html"), page(plain + grouped + collapsed));

const browser = await chromium.launch();
const p = await browser.newPage({ viewport: { width: 1000, height: 120 }, deviceScaleFactor: 3 });
await p.goto(`file://${join(dir, "index.html")}`);

const m = await p.evaluate(() => {
  const h = (id) => document.getElementById(id).getBoundingClientRect().height;
  const chip = document.querySelector(".tg-chip").getBoundingClientRect();
  const runBox = document.querySelector("#b .tg-run.grouped").getBoundingClientRect();
  const members = [...document.querySelectorAll(".tab.tg-member")].map((e) => e.getBoundingClientRect());
  const after = document.querySelector("#b .tg-run:not(.grouped) .tab").getBoundingClientRect();
  const plainTab = document.querySelector("#a .tab").getBoundingClientRect();
  return {
    plain: h("a"),
    grouped: h("b"),
    chip: chip.height,
    member: members[0].height,
    tab: plainTab.height,
    // **線はグループ全体に架かる**（チップの左端から末尾タブの右端まで）
    runSpansChip: Math.round(runBox.left - chip.left) === 0,
    runSpansLast: Math.round(runBox.right - members[members.length - 1].right) === 0,
    // 線の太さ（疑似要素なので計算スタイルから取る）と、チップの底との距離
    lineHeight: parseFloat(
      getComputedStyle(document.querySelector("#b .tg-run.grouped"), "::before").height
    ),
    chipBottomGap: runBox.bottom - chip.bottom,
    // ボタンらしい余白（チップは器の中で浮く）と、メンバー同士は詰める
    chipToFirst: members[0].left - chip.right,
    chipTopInset: chip.top - runBox.top,
    betweenMembers: members[1].left - members[0].right,
    afterGroup: after.left - members[members.length - 1].right,
    // 折りたたみ中: チップだけが残る。ここでも行高を超えない
    collapsedStrip: h("c"),
    collapsedChip: document.querySelector("#c .tg-chip").getBoundingClientRect().height
  };
});
// **両テーマの絵を残す**。配色は `:root[data-theme]` で切り替わるので、
// 片方だけ見て「読める」と判断すると、もう片方でコントラストが落ちていても気づけない
await p.screenshot({ path: join(dir, "tab-groups-dark.png") });
await p.evaluate(() => document.documentElement.setAttribute("data-theme", "light"));
await p.screenshot({ path: join(dir, "tab-groups-light.png") });
await browser.close();

const rows = [
  ["タブ帯（グループなし）", m.plain],
  ["タブ帯（グループあり）", m.grouped],
  ["タブ 1 枚（グループ外）", m.tab],
  ["タブ 1 枚（メンバー）", m.member],
  ["チップ（ボタン）", m.chip],
  ["余白: チップ→先頭タブ", m.chipToFirst],
  ["余白: run 上端→チップ", m.chipTopInset],
  ["線の太さ", m.lineHeight],
  ["チップ底→run 下端", m.chipBottomGap],
  ["隙間: メンバー同士", m.betweenMembers],
  ["隙間: グループ→次のタブ", m.afterGroup],
  ["タブ帯（折りたたみ中）", m.collapsedStrip],
  ["チップ（折りたたみ中）", m.collapsedChip]
];
for (const [k, v] of rows) console.log(`${k.padEnd(24)} ${v.toFixed(2)}px`);

const fail = [];
if (m.grouped !== m.plain) fail.push(`タブ帯が高くなった: ${m.plain} → ${m.grouped}`);
if (m.member !== m.tab) fail.push(`メンバータブの高さが変わった: ${m.tab} → ${m.member}`);
if (m.plain !== 28) fail.push(`タブ帯が 28px（--chrome-row-h）でない: ${m.plain}`);
if (m.chip > m.plain) fail.push(`チップが行高を超えた: ${m.chip} > ${m.plain}`);
// **線がグループ全体に架かる**（チップとタブを結ぶのはこの線。利用者の指摘）
if (!m.runSpansChip) fail.push("上端の線がチップの左端まで届いていない");
if (!m.runSpansLast) fail.push("上端の線が末尾タブの右端まで届いていない");
// チップは角丸四角のボタン＝器の中で少し浮く。タブと同じ高さに張り付かせない
if (m.chip >= m.member) fail.push(`チップがタブと同じ高さ（ボタンに見えない）: ${m.chip} vs ${m.member}`);
if (m.chipTopInset <= 0) fail.push(`チップが run の上端に張り付いている: ${m.chipTopInset}px`);
// **ボタンの底が下端の線に接する**（利用者の指示）。食い込んでも浮いても駄目
if (m.chipBottomGap !== m.lineHeight) {
  fail.push(`チップの底が線に接していない: 隙間 ${m.chipBottomGap}px / 線 ${m.lineHeight}px`);
}
if (m.chipToFirst <= 0 || m.chipToFirst > 8) fail.push(`チップと先頭タブの余白が不自然: ${m.chipToFirst}px`);
if (m.betweenMembers !== 0) fail.push(`メンバー同士の間に隙間: ${m.betweenMembers}px`);
if (m.afterGroup <= 0) fail.push(`グループの外まで詰まっている（境目が消える）: ${m.afterGroup}px`);
// 折りたたみ中も同じ行に収まる（チップだけが残る状態）
if (m.collapsedStrip !== m.plain) fail.push(`折りたたみでタブ帯が変わった: ${m.plain} → ${m.collapsedStrip}`);
if (m.collapsedChip !== m.chip) fail.push(`折りたたみでチップの大きさが変わった: ${m.chip} → ${m.collapsedChip}`);

console.log(`\nスクリーンショット: ${join(dir, "tab-groups-dark.png")}`);
console.log(`                    ${join(dir, "tab-groups-light.png")}`);
if (fail.length > 0) {
  console.error("\nRESULT: FAIL");
  for (const f of fail) console.error(`  - ${f}`);
  process.exit(1);
}
console.log("\nRESULT: PASS（グループの有無でタブ帯の高さが変わらない）");
