/**
 * **スプール（帳票）を自己完結 HTML に描き出す。** `renderSpoolPdf` の HTML 版。
 *
 * PDF は「紙に落とす」ためのもので、開くのに閲覧環境が要り、差分も取れない。
 * こちらはブラウザだけで開けて、ページを行き来でき、テキストとして検索・コピーできる。
 * 印刷すればページ区切りも保たれる（`@media print` の `break-after`）。
 *
 * ## 守っている約束（`screen-html.ts` と同じ）
 *
 * - **決定的**: 同じ入力から必ず同じ HTML が出る。`Date.now()` / `Math.random()` を呼ばず、
 *   日時は `meta` で受け取る。差分が取れることがエビデンスの前提。
 * - **自己完結**: 外部の CSS / JS / Web フォント / 画像を一切参照しない。
 * - **押せる部品を置かない**: 読み取り専用の記録なので入力欄もボタンも出さない
 *   （ページ送りだけは例外。読むために要る）。
 *
 * ## 桁がずれない理由
 *
 * `LogicalPage.lines` の 1 行は**桁詰めされた文字列**だが、全角文字は 1 文字で 2 桁を占める
 * （`ScsDecoder.putWide` が継続桁に空文字列を置き、`join("")` で落ちるため）。
 * 素のテキストとして流すと、開いた環境のフォントが全角を 1 桁で描いた瞬間に以降が左へずれる。
 * **全角は必ず `width:2ch` の箱に入れる**——必要な前提が「ASCII が等幅」だけになる。
 * 全角の判定は `isFullWidth`（core に一本化した East Asian Width の表）を使う。
 */

import type { LogicalPage } from "./scs.js";
// **行の組み立ては共用**（`report-line.ts`）。画面（web-ui の ReportText）と同じ関数を通す
// ——ここを別々に書くと「画面ではこう見えるのに保存した HTML では違う」が起きる。
import { reportLineSegs, lineHasAlt, type ReportSeg, type SbcsReading } from "./report-line.js";

/** エビデンスの見出しに載せる情報。**日時は呼び出し側が渡す**（この層は時計を持たない） */
export interface SpoolHtmlMeta {
  /** 取得日時（ISO 8601） */
  capturedAt?: string;
  sessionId?: string;
  /** 接続先（`host:port` 等） */
  host?: string;
  /** スプール識別子（`wait_spool` / `list_spools` が返す spoolId） */
  spoolId?: string;
  /** ページの題。省略時は既定の文言 */
  title?: string;
  /** 自由記述の注記 */
  note?: string;
}

/**
 * **描き方の指定**（メタ情報＝見出しに載る事実とは別物なので分けて受ける）。
 * どれも**開いたときの状態**でしかない——読み手はページ内で切り替えられる。
 */
export interface SpoolHtmlStyle {
  /**
   * SO/SI マークを最初から出しておくか（既定 false＝非表示）。
   *
   * **出すと桁が右へずれる。** SCS の SO/SI は桁を占めない（`ScsDecoder` は昔から
   * シフトで桁を進めない）ので、印を描くには桁を 1 つ借りるしかない。既定を非表示に
   * してあるのはそのため——**紙と突き合わせるときは消しておく**。
   */
  shiftMarks?: boolean;
  /** 表示コード切替（カナ ⇄ 英）。渡すと両方の読みを HTML に入れる */
  sbcs?: SpoolSbcsToggle;
  /** 開いたときのフォント（`SPOOL_FONTS` の id。既定は先頭＝標準） */
  font?: string;
}

/**
 * 表示コード切替の指定。`host` は**そのまま描いた字がどちらの読みか**——
 * 帳票の復号コードページを知っているのは呼び出し側だけなので受け取る。
 */
export interface SpoolSbcsToggle {
  host: SbcsReading;
  /** 開いたときにどちらを見せるか（既定は `host`） */
  initial?: SbcsReading;
}

/**
 * 選べるフォント。**自己完結なので Web フォントは積めない**——読み手の環境にある物だけを
 * 指名し、無ければ標準へ落ちる（どの候補も最後に標準の並びを足してある）。
 * 候補は web-ui の画面フォントと同じ顔ぶれにしてある。
 */
const STD_STACK = `ui-monospace,"SFMono-Regular",Menlo,Consolas,"BIZ UDGothic","MS Gothic",monospace`;
const SPOOL_FONTS: { id: string; label: string; stack: string }[] = [
  { id: "std", label: "標準", stack: STD_STACK },
  { id: "bizud", label: "BIZ UDゴシック", stack: `"BIZ UDGothic","BIZ UDPGothic",${STD_STACK}` },
  { id: "msg", label: "MS ゴシック", stack: `"MS Gothic","Osaka-Mono",${STD_STACK}` },
  { id: "hackgen", label: "白源 HackGen", stack: `"HackGen Console NF","HackGen35 Console NF","HackGen Console","HackGen",${STD_STACK}` },
  { id: "udev", label: "UDEV Gothic", stack: `"UDEV Gothic NF","UDEV Gothic 35NF","UDEV Gothic",${STD_STACK}` },
  { id: "plemol", label: "PlemolJP", stack: `"PlemolJP Console NF","PlemolJP Console","PlemolJP",${STD_STACK}` },
  { id: "cica", label: "Cica", stack: `"Cica",${STD_STACK}` }
];

/** もう一方の読み */
function otherReading(r: SbcsReading): SbcsReading {
  return r === "kana" ? "latin" : "kana";
}

/** 切り替えラベルに出す名前（web-ui の画面設定「表示コード」と同じ言葉） */
const SBCS_LABELS: Record<SbcsReading, string> = { kana: "カナ", latin: "英" };

/**
 * HTML エスケープ。テキストにも属性値にも同じものを通す
 * （`screen-html.ts` と同じ理由——2 種類に分けると片方だけ通し忘れる）。
 */
function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * 1 行を span の並びにする。区間分けは `reportLineSegs`（画面と共用）に任せ、
 * ここは**その区間を HTML にする**だけ。
 *
 * - 全角は 2 桁の箱（`w`）に入れる——フォントに桁幅を委ねない
 * - 読みで字が変わる区間だけ 2 つ出す（`va`＝そのまま／`vb`＝もう一方）。変わらない区間は
 *   素のテキストのまま＝**span も増えず HTML も太らない**
 * - SO/SI の印は常に入れておき、見せるかは CSS で決める（`TOGGLE_CSS`）
 */
function renderLine(
  line: string,
  raw: readonly (number | undefined)[],
  shifts: readonly import("./scs.js").ShiftMark[],
  alt: SbcsReading | undefined
): string {
  return reportLineSegs(line, raw, shifts, alt, true)
    .map((seg: ReportSeg) => {
      if (seg.kind === "wide") return `<span class="w">${esc(seg.text)}</span>`;
      if (seg.kind === "mark") return `<span class="so">${seg.text}</span>`;
      return seg.alt === undefined
        ? esc(seg.text)
        : `<span class="va">${esc(seg.text)}</span><span class="vb">${esc(seg.alt)}</span>`;
    })
    .join("");
}

/** 1 ページ。桁数は `cols`（等幅の箱の幅）で固定する */
function pageFigure(
  p: LogicalPage,
  index: number,
  total: number,
  alt: SbcsReading | undefined
): string {
  const lines = p.lines
    .map((l, r) => `<div class="ln">${renderLine(l, p.raw?.[r] ?? [], p.shifts?.[r] ?? [], alt)}</div>`)
    .join("");
  return (
    `<figure class="pg" data-page="${index + 1}">` +
    `<figcaption>${index + 1} / ${total}　·　${p.rows} 行 × ${p.cols} 桁</figcaption>` +
    `<div class="paper"><div class="sheet" style="width:${p.cols}ch">${lines}</div></div>` +
    `</figure>`
  );
}

/** メタ情報の行。値が無い項目は出さない */
function metaHtml(meta: SpoolHtmlMeta, extra: [string, string][]): string {
  const rows: [string, string][] = [];
  if (meta.capturedAt) rows.push(["取得日時", meta.capturedAt]);
  if (meta.sessionId) rows.push(["セッション", meta.sessionId]);
  if (meta.host) rows.push(["接続先", meta.host]);
  if (meta.spoolId) rows.push(["スプール", meta.spoolId]);
  rows.push(...extra);
  if (meta.note) rows.push(["注記", meta.note]);
  if (rows.length === 0) return "";
  return (
    `<dl class="meta">` +
    rows.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join("") +
    `</dl>`
  );
}

/**
 * **切り替えは CSS だけで作る**（`screen-html.ts` と同じ作り）。チェックボックス／ラジオと
 * `:checked ~`（一般兄弟結合子）だけで動くので、**JS を切っても・CSP で script を止められても
 * 生きる**。エビデンスとして配る HTML なので、読み手の環境に依存する部分は少ないほうがいい。
 *
 * 状態を持つ `<input>` は**本文（`.page`）より前**に置く——CSS は先祖にも前の兄弟にも
 * 遡れず、辿れるのは後ろの兄弟だけだから。ラベルは**今の状態**を出す。
 *
 * フォントは 2 値ではないので、SO/SI の順送りと同じ形にする: 状態の数だけラベルを置き、
 * 「今の状態」のものだけ見せ、押すと次へ進む＝**ボタン 1 つが候補を一巡する**。
 */
const FONT_CSS = SPOOL_FONTS.map(
  (f, i) =>
    `#g${i}:checked ~ .page .sheet{--sheet-mono:${f.stack}}\n` +
    `#g${i}:checked ~ .page label[for=g${(i + 1) % SPOOL_FONTS.length}]{display:inline-flex}`
).join("\n");

const TOGGLE_CSS = `
.fw{display:none}
.tg{position:absolute;width:1px;height:1px;opacity:0;margin:0;pointer-events:none}
.btn>span{display:none}
.btn>.st-off{display:inline}
#t:checked ~ .page label[for=t]>.st-off,#k:checked ~ .page label[for=k]>.st-off,
#s:checked ~ .page label[for=s]>.st-off{display:none}
#t:checked ~ .page label[for=t]>.st-on,#k:checked ~ .page label[for=k]>.st-on,
#s:checked ~ .page label[for=s]>.st-on{display:inline}
/* 表示コード: 必ず片方だけが出るので桁は動かない */
.sheet .vb{display:none}
#k:checked ~ .page .sheet .va{display:none}
#k:checked ~ .page .sheet .vb{display:inline}
/* SO/SI: 桁を 1 つ借りて描く。本物の { } と見分けが付くよう淡く */
.so{display:none;width:1ch;color:color-mix(in srgb,var(--ink) 45%,var(--paper));
user-select:none;-webkit-user-select:none}
#s:checked ~ .page .so{display:inline-block}
`;

/**
 * 帳票の配色。**画面（CRT）ではなく紙**に寄せる——スプールは印刷物なので、
 * 緑地に緑文字で出すと元の帳票と見比べられない。既定はライト、`#t` を入れると反転。
 *
 * **暗色の変数は `:root` ではなく `.page` に置く。** チェックボックスから `:root` は辿れない
 * （CSS は先祖へ遡れない）が、**後ろの兄弟**なら `~` で辿れるので、本文をまるごと `.page` に
 * 入れてそこへ被せる（`screen-html.ts` と同じ手）。
 */
const STYLE = `
:root{--bg:#f4f6f2;--fg:#1f2937;--card:#fff;--line:#d3d9cf;--muted:#5b6b61;
--paper:#fff;--paper-edge:#c9d1c6;--ink:#101418}
#t:checked ~ .page{--bg:#0b0f0d;--fg:#c9d6cd;--card:#111815;--line:#22302a;--muted:#8ba396;
--paper:#12181a;--paper-edge:#26322c;--ink:#dbe5dd}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);
font:13px/1.5 ui-sans-serif,system-ui,"Hiragino Kaku Gothic ProN","Noto Sans JP",sans-serif}
.page{min-height:100vh;padding:16px;background:var(--bg);color:var(--fg)}
header{display:flex;align-items:center;gap:12px;flex-wrap:wrap;margin-bottom:12px}
h1{font-size:15px;margin:0}
button,.btn{font:inherit;height:28px;padding:0 10px;display:inline-flex;align-items:center;
background:var(--card);color:var(--fg);border:1px solid var(--line);border-radius:6px;cursor:pointer}
button:disabled{opacity:.45;cursor:default}
.meta{display:grid;grid-template-columns:auto 1fr;gap:2px 12px;margin:0 0 12px;
font-size:12px;color:var(--muted)}
.meta dt{white-space:nowrap}
.meta dd{margin:0;word-break:break-all}
.nav{display:flex;gap:6px;flex-wrap:wrap;align-items:center;margin-bottom:10px;font-size:12px}
.nav button.on{outline:2px solid var(--fg)}
figure.pg{margin:0 0 12px}
figcaption{font-size:12px;color:var(--muted);margin-bottom:6px}
/* 帳票は 132 桁が珍しくない。**横は紙の中だけでスクロールさせる**（body を横に流さない） */
.paper{display:inline-block;max-width:100%;overflow-x:auto;background:var(--paper);
border:1px solid var(--paper-edge);border-radius:4px;padding:12px 14px}
.sheet{color:var(--ink);font-family:var(--sheet-mono);
font-size:13px;line-height:1.35;white-space:pre}
.ln{min-height:1.35em}
/* 全角は必ず 2 桁の箱に入れる（フォントに依らせない） */
.w{display:inline-block;width:2ch;overflow:hidden;vertical-align:top;text-align:left}
[hidden]{display:none!important}
/* 印刷では全ページを出し、ページ区切りを保つ（PDF と同じ体裁で紙に落とせる） */
@media print{
  body{padding:0;background:#fff;color:#000}
  header,.nav,.meta{display:none}
  figure.pg{display:block!important;break-after:page;page-break-after:always}
  figure.pg:last-child{break-after:auto;page-break-after:auto}
  figcaption{display:none}
  .paper{border:0;padding:0;overflow:visible}
}
${TOGGLE_CSS}${FONT_CSS}`;

/**
 * ページ送り。**JS はこれだけになった**（テーマ・表示コード・SO/SI・フォントは CSS だけで動く）。
 *
 * ここを CSS にしないのは、ページ数ぶんのラベルと規則を並べることになり
 * **枚数に比例して HTML と CSS が膨らむ**ため。切っても中身は読める
 * （印刷用 CSS が全ページを出すので、JS 無しでも全ページが縦に並ぶ）。
 */
const JS = `
var pgs=[].slice.call(document.querySelectorAll('figure.pg'));
var bs=[].slice.call(document.querySelectorAll('.nav .jump'));
var i=0;
function show(n){
  i=Math.max(0,Math.min(pgs.length-1,n));
  pgs.forEach(function(p,k){p.hidden=k!==i});
  bs.forEach(function(b,k){b.className='jump'+(k===i?' on':'')});
  document.getElementById('p').disabled=i===0;
  document.getElementById('n').disabled=i===pgs.length-1;
  document.getElementById('pos').textContent=(i+1)+' / '+pgs.length;
}
document.getElementById('p').onclick=function(){show(i-1)};
document.getElementById('n').onclick=function(){show(i+1)};
bs.forEach(function(b,k){b.onclick=function(){show(k)}});
document.addEventListener('keydown',function(e){
  if(e.key==='ArrowLeft')show(i-1);
  if(e.key==='ArrowRight')show(i+1);
});
// 印刷時は全ページを見せる（1 ページだけ印刷される事故を防ぐ）
function showAll(v){pgs.forEach(function(p){p.hidden=v?false:pgs.indexOf(p)!==i})}
window.addEventListener('beforeprint',function(){showAll(true)});
window.addEventListener('afterprint',function(){showAll(false)});
show(0);`;

/**
 * スプール 1 件ぶんのエビデンス HTML。
 *
 * @param pages 論理ページ（`SpoolReport.pages`／`ScsDecoder` の出力）
 * @param meta 見出しに載せる情報（**日時は呼び出し側が渡す**）
 */
/** 状態を出すラベル（`st-off` が素の状態、`st-on` がチェック済みの状態） */
function toggleLabel(id: string, off: string, on: string): string {
  return `<label class="btn" for="${id}"><span class="st-off">${esc(off)}</span><span class="st-on">${esc(on)}</span></label>`;
}

/**
 * フォントの順送りボタン。**ラベル i は「今が候補 i」のときだけ見え、押すと次へ進む**
 * ——見えているのは常に 1 つなので、利用者にはボタン 1 つが回っているように見える。
 */
function fontLabels(): string {
  return SPOOL_FONTS.map(
    (f, i) =>
      `<label class="btn fw" for="g${(i + 1) % SPOOL_FONTS.length}">フォント: ${esc(f.label)}</label>`
  ).join("");
}

/** その帳票に読み替わる桁があるか（**無ければ切り替えを出さない**） */
function hasSbcsAlt(pages: readonly LogicalPage[], alt: SbcsReading): boolean {
  return pages.some((p) => p.lines.some((line, r) => lineHasAlt(line, p.raw?.[r], alt)));
}

/** その帳票に SO/SI があるか（**無ければ切り替えを出さない**） */
function hasShifts(pages: readonly LogicalPage[]): boolean {
  return pages.some((p) => (p.shifts ?? []).some((row) => row.length > 0));
}

/**
 * スプール 1 件ぶんのエビデンス HTML。
 *
 * @param pages 論理ページ（`SpoolReport.pages`／`ScsDecoder` の出力）
 * @param meta 見出しに載せる情報（**日時は呼び出し側が渡す**）
 * @param style 開いたときの見え方（どれもページ内で切り替えられる）
 */
export function renderSpoolHtml(
  pages: readonly LogicalPage[],
  meta: SpoolHtmlMeta = {},
  style: SpoolHtmlStyle = {}
): string {
  const title = meta.title ?? "5250 スプール";
  const list = pages.length > 0 ? pages : [{ rows: 1, cols: 1, lines: [""] } as LogicalPage];
  const alt = style.sbcs ? otherReading(style.sbcs.host) : undefined;
  const showSbcs = alt !== undefined && hasSbcsAlt(list, alt);
  const showSosi = hasShifts(list);
  const fontIdx = Math.max(0, SPOOL_FONTS.findIndex((f) => f.id === style.font));
  const body =
    `<header><h1>${esc(title)}</h1>` +
    toggleLabel("t", "☀ 通常", "🌙 ダーク") +
    fontLabels() +
    // 出す桁が無い帳票には出さない（押しても何も起きない部品を置かない）
    (showSosi ? toggleLabel("s", "SO/SI 非表示", "SO/SI 表示") : "") +
    (showSbcs && style.sbcs
      ? toggleLabel(
          "k",
          `表示コード: ${SBCS_LABELS[style.sbcs.host]}`,
          `表示コード: ${SBCS_LABELS[otherReading(style.sbcs.host)]}`
        )
      : "") +
    `</header>` +
    metaHtml(meta, [["ページ数", String(pages.length)]]) +
    `<div class="nav">` +
    list.map((_, i) => `<button type="button" class="jump">${i + 1}</button>`).join("") +
    `</div><div class="nav">` +
    `<button id="p" type="button">← 前</button><span id="pos"></span>` +
    `<button id="n" type="button">次 →</button></div>` +
    list.map((p, i) => pageFigure(p, i, list.length, showSbcs ? alt : undefined)).join("");
  return (
    `<!DOCTYPE html><html lang="ja"><head><meta charset="utf-8">` +
    `<meta name="viewport" content="width=device-width,initial-scale=1">` +
    `<title>${esc(title)}</title><style>${STYLE}</style></head><body>` +
    `<input class="tg" type="checkbox" id="t">` +
    SPOOL_FONTS.map(
      (_, i) => `<input class="tg" type="radio" name="g" id="g${i}"${i === fontIdx ? " checked" : ""}>`
    ).join("") +
    (showSosi ? `<input class="tg" type="checkbox" id="s"${style.shiftMarks ? " checked" : ""}>` : "") +
    (showSbcs && style.sbcs
      ? `<input class="tg" type="checkbox" id="k"${
          (style.sbcs.initial ?? style.sbcs.host) !== style.sbcs.host ? " checked" : ""
        }>`
      : "") +
    `<div class="page">` +
    body +
    `</div><script>${JS}</script></body></html>`
  );
}
