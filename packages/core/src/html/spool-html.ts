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

import type { LogicalPage } from "@as400web/scs";
import { isFullWidth } from "../text/east-asian-width.js";

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
 * 1 行を span の並びにする。**全角は 2 桁の箱に入れ、半角の連なりはまとめる**。
 *
 * 帳票には属性が無い（SCS は色も強調も持たない）ので、分けるのは幅の都合だけ。
 * 半角だけの行なら span は 1 つで済む。
 */
function renderLine(line: string): string {
  let out = "";
  let run = "";
  const flush = (): void => {
    if (run === "") return;
    out += esc(run);
    run = "";
  };
  for (const ch of line) {
    if (isFullWidth(ch)) {
      flush();
      out += `<span class="w">${esc(ch)}</span>`;
    } else {
      run += ch;
    }
  }
  flush();
  return out;
}

/** 1 ページ。桁数は `cols`（等幅の箱の幅）で固定する */
function pageFigure(p: LogicalPage, index: number, total: number): string {
  const lines = p.lines.map((l) => `<div class="ln">${renderLine(l)}</div>`).join("");
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
 * 帳票の配色。**画面（CRT）ではなく紙**に寄せる——スプールは印刷物なので、
 * 緑地に緑文字で出すと元の帳票と見比べられない。既定はライト、`data-theme="dark"` で反転。
 */
const STYLE = `
:root{--bg:#f4f6f2;--fg:#1f2937;--card:#fff;--line:#d3d9cf;--muted:#5b6b61;
--paper:#fff;--paper-edge:#c9d1c6;--ink:#101418}
:root[data-theme=dark]{--bg:#0b0f0d;--fg:#c9d6cd;--card:#111815;--line:#22302a;--muted:#8ba396;
--paper:#12181a;--paper-edge:#26322c;--ink:#dbe5dd}
*{box-sizing:border-box}
body{margin:0;padding:16px;background:var(--bg);color:var(--fg);
font:13px/1.5 ui-sans-serif,system-ui,"Hiragino Kaku Gothic ProN","Noto Sans JP",sans-serif}
header{display:flex;align-items:center;gap:12px;flex-wrap:wrap;margin-bottom:12px}
h1{font-size:15px;margin:0}
button{font:inherit;height:28px;padding:0 10px;display:inline-flex;align-items:center;
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
.sheet{color:var(--ink);
font-family:ui-monospace,"SFMono-Regular",Menlo,Consolas,"BIZ UDGothic","MS Gothic",monospace;
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
`;

/**
 * テーマ切替とページ送り。**JS はこれだけ。切っても中身は読める**
 * （印刷用 CSS が全ページを出すので、JS 無しでも全ページが縦に並ぶ）。
 */
const JS = `
var r=document.documentElement;
document.getElementById('t').onclick=function(){
  var d=r.getAttribute('data-theme')==='dark';
  r.setAttribute('data-theme',d?'light':'dark');
  this.textContent=d?'🌙 ダーク':'☀ ライト';
};
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
export function renderSpoolHtml(pages: readonly LogicalPage[], meta: SpoolHtmlMeta = {}): string {
  const title = meta.title ?? "5250 スプール";
  const list = pages.length > 0 ? pages : [{ rows: 1, cols: 1, lines: [""] } as LogicalPage];
  const body =
    `<header><h1>${esc(title)}</h1>` +
    `<button id="t" type="button">🌙 ダーク</button></header>` +
    metaHtml(meta, [["ページ数", String(pages.length)]]) +
    `<div class="nav">` +
    list.map((_, i) => `<button type="button" class="jump">${i + 1}</button>`).join("") +
    `</div><div class="nav">` +
    `<button id="p" type="button">← 前</button><span id="pos"></span>` +
    `<button id="n" type="button">次 →</button></div>` +
    list.map((p, i) => pageFigure(p, i, list.length)).join("");
  return (
    `<!DOCTYPE html><html lang="ja"><head><meta charset="utf-8">` +
    `<meta name="viewport" content="width=device-width,initial-scale=1">` +
    `<title>${esc(title)}</title><style>${STYLE}</style></head><body>` +
    body +
    `<script>${JS}</script></body></html>`
  );
}
