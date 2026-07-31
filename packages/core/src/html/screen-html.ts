/**
 * **`ScreenSnapshot` を自己完結 HTML に描き出す（自動操作のエビデンス用）。**
 *
 * MCP のテキスト出力（`screenToText`）は桁位置こそ保つが色も強調も無く、属性 run
 * （`attributeRuns`）は機械可読でも人の目には読めず、ANSI（`screenToAnsi`）は端末でしか
 * 見えない。「操作の結果を人に見せて残す」にはどれも足りない——そこを埋めるのがここ。
 *
 * ## 守っている約束
 *
 * - **決定的**: 同じ入力から必ず同じ HTML が出る。`Date.now()` / `Math.random()` を呼ばず、
 *   日時のような非決定要素は `meta` で受け取る。差分が取れることがエビデンスの前提。
 * - **自己完結**: 外部の CSS / JS / Web フォント / 画像を一切参照しない。ネットワークの無い
 *   場所で開いても同じに見える。
 * - **単票と履歴で描画経路を分けない**: どちらも `screenFigure()` を通る。分けると
 *   「1 枚で見たときと履歴で見たときで違う」が起こり、証拠として信用できなくなる。
 * - **押せる部品を置かない**: 読み取り専用の記録なので `<input>` も AID ボタンも出さない
 *   （出すと「押せる」と誤解させる）。
 *
 * ## 桁がずれない理由（ここが忠実さの核）
 *
 * 桁は `ch`、行高は `1.25em` で数える。**全角セルは必ず `width:2ch` の箱に入れる**——
 * web-ui（`ScreenGrid.vue`）は East Asian Width が Ambiguous な文字（U+2212 `−`・罫線・
 * ギリシャ等）だけを箱に入れ、確実に全角の字はフォントに任せているが、**配布 HTML は
 * Web フォントを持てない**ので、開いた環境のフォント次第で崩れる余地を残せない。
 * 全部箱に入れれば必要な前提は「ASCII が等幅」だけになる。
 */

import type {
  Cell,
  Field,
  GuiConstructs,
  GuiGridLine,
  GuiSelectionField,
  GuiWindow,
  ScreenColor,
  ScreenSnapshot
} from "../screen/types.js";
import { GRID_COLOR, GRID_LINE_STYLE } from "../protocol/wdsf-parser.js";

/** コーデックが「この表にマップの無いバイト」を返すときの文字（`buffer.ts` と同じ） */
const UNDISPLAYABLE = "�";

/** エビデンスの見出しに載せる情報。**日時は呼び出し側が渡す**（この層は時計を持たない） */
export interface ScreenHtmlMeta {
  /** 取得日時（ISO 8601）。呼び出し側が `new Date().toISOString()` 等で採る */
  capturedAt?: string;
  sessionId?: string;
  /** 接続先（`host:port` 等） */
  host?: string;
  /** ジョブ識別子（`番号/ユーザー/ジョブ名`） */
  job?: string;
  /** ページの題。省略時は既定の文言 */
  title?: string;
  /** 自由記述の注記 */
  note?: string;
}

/** 履歴 1 コマ。画面と、その画面を出した操作 */
export interface ScreenHistoryEntry {
  screen: ScreenSnapshot;
  /** この画面の直前に送った AID キー（最初の画面には無い） */
  key?: string;
  capturedAt?: string;
  note?: string;
}

/* ------------------------------------------------------------------ *
 * エスケープ
 * ------------------------------------------------------------------ */

/**
 * **HTML エスケープ。テキストにも属性値にも同じものを通す。**
 *
 * 画面文字・窓見出し・メタ情報はすべてホスト由来で、`<` や `"` がそのまま来る。
 * 変換を 2 種類に分けると「属性の方だけ通し忘れる」が起こるので 1 つに寄せる。
 */
function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/* ------------------------------------------------------------------ *
 * セル → クラス
 * ------------------------------------------------------------------ */

/**
 * **桁区切り（CS）は黄・青緑では「書き手の意図」の印にならない。**
 *
 * 5250 の属性バイト表（SC30-3533）には黄・青緑を「修飾なし」で表す値が無く、
 * `COLOR(YLW)` を単体で指定しただけでも桁区切りビット付きの値になる。属性バイトからは
 * `DSPATR(CS)` を本当に頼んだのか区別できないので、この 2 色では出さない
 * （web-ui の `hasRealColsep` と同じ規則）。
 */
function hasRealColsep(color: ScreenColor, columnSeparator: boolean): boolean {
  return columnSeparator && color !== "yellow" && color !== "turquoise";
}

function cellClass(c: Cell): string {
  let cls = `c-${c.color}`;
  if (c.underline) cls += " a-u";
  if (c.reverse) cls += " a-r";
  if (c.blink) cls += " a-b";
  if (hasRealColsep(c.color, c.columnSeparator)) cls += " a-cs";
  return cls;
}

/**
 * そのセルに出す 1 文字（非表示は伏せ、制御桁と DBCS tail は空白）。
 *
 * **表示できないバイト（U+FFFD）は空白にする（ACS と同じ）。** EBCDIC の表にはマップの
 * 無いバイトがあり、コーデックはそこを U+FFFD で返す。そのまま描くと実機に無い「�」が
 * エビデンスに写り込む。web-ui（`ScreenGrid.vue` の `displayText`）と同じ扱いに揃える
 * ——同じ画面を 2 つの描画経路で見て絵が違うなら、証拠として使えない。
 */
function cellChar(c: Cell): string {
  if (c.nonDisplay) return " ";
  if (c.char === "" || c.char === UNDISPLAYABLE) return " ";
  return c.char;
}

const isLead = (c: Cell | undefined): boolean => c?.kind === "dbcs-lead";
const isTail = (c: Cell | undefined): boolean => c?.kind === "dbcs-tail";

/* ------------------------------------------------------------------ *
 * 1 行の描画
 * ------------------------------------------------------------------ */

/**
 * 1 行を span の並びにする。属性が同じ SBCS の連なりは 1 つの span にまとめ、
 * **全角は必ず箱に入れる**（`w`=2桁 / `h`=1桁）。
 *
 * `h`（1 桁の箱）は**対を失った全角**のため。ホストが桁末尾で全角を切ると lead だけ、
 * あるいは tail だけが残る。ACS はこれを 1 桁ぶんの分断された字形で見せるので合わせる。
 */
function renderRow(row: readonly Cell[]): string {
  let out = "";
  let runCls = "";
  let runText = "";
  const flush = (): void => {
    if (runText === "") return;
    out += `<span class="${runCls}">${esc(runText)}</span>`;
    runText = "";
  };
  for (let i = 0; i < row.length; i++) {
    const c = row[i]!;
    const cls = cellClass(c);
    // lead の次が tail＝正常な全角。lead 側で 2 桁ぶんを描き、tail 桁は読み飛ばす
    if (isLead(c) && isTail(row[i + 1])) {
      flush();
      out += `<span class="w ${cls}">${esc(cellChar(c))}</span>`;
      i++; // tail をスキップ
      continue;
    }
    // 対を失った全角（lead に tail が無い／tail に lead が無い）は 1 桁の箱で分断表示
    if (isLead(c) || isTail(c)) {
      flush();
      out += `<span class="h ${cls}">${esc(isTail(c) ? " " : cellChar(c))}</span>`;
      continue;
    }
    if (cls !== runCls) {
      flush();
      runCls = cls;
    }
    runText += cellChar(c);
  }
  flush();
  return out;
}

/* ------------------------------------------------------------------ *
 * 重ねる要素
 * ------------------------------------------------------------------ */

/** 桁・行を CSS の座標に（桁は ch、行は 1.25em）。行高を 1 か所に閉じ込める */
const X = (col0: number): string => `${col0}ch`;
const Y = (row0: number): string => `${row0 * 1.25}em`;

function cursorHtml(snap: ScreenSnapshot): string {
  const { row, col } = snap.cursor;
  if (row < 1 || col < 1 || row > snap.rows || col > snap.cols) return "";
  return `<div class="cur" style="left:${X(col - 1)};top:${Y(row - 1)}"></div>`;
}

/**
 * 入力欄の下線。**値は書かない**——セルから既に描かれており、`fields[].value` を使うと
 * 非表示欄（パスワード）の中身を HTML に載せる経路を作ってしまう。
 */
function fieldsHtml(snap: ScreenSnapshot): string {
  return snap.fields
    .map((f: Field) => {
      if (f.row < 1 || f.col < 1 || f.row > snap.rows) return "";
      const cls = f.protected ? "fld fld-p" : "fld";
      return (
        `<div class="${cls}" style="left:${X(f.col - 1)};top:${Y(f.row - 1)};width:${f.length}ch"></div>`
      );
    })
    .join("");
}

/**
 * 線種（原典 `GRID_LINE_STYLE`）→ CSS クラス。**web-ui の `gridLineClass` と同じ表**。
 *
 * ここを独自に書くと、同じ画面が web-ui と HTML で違う線に見える（実測で
 * 0x03 点線を破線・0x08 破線を実線として描いていた）。太破線・二重破線は
 * CSS に該当が無いので web-ui と同じ代替に寄せる。
 */
function gridLineClass(style: number): string {
  switch (style) {
    case GRID_LINE_STYLE.THICK_SOLID:
      return "gl-thick";
    case GRID_LINE_STYLE.DOUBLE:
      return "gl-double";
    case GRID_LINE_STYLE.DOTTED:
      return "gl-dotted";
    case GRID_LINE_STYLE.DASHED:
      return "gl-dashed";
    case GRID_LINE_STYLE.THICK_DASHED:
      return "gl-dashed gl-thick";
    case GRID_LINE_STYLE.DOUBLE_DASHED:
      return "gl-double";
    default: // 0x00 実線 / 0xFF 端末既定
      return "";
  }
}

/**
 * ホストが引いた罫線（GRDATR / GRDLIN）。
 *
 * **罫線はセルの中ではなく「セルの境界」に引く。** 箱の下辺は最終行の下端＝`row+height`、
 * 右辺は最終桁の右端＝`col+width`。行番号・桁番号のまま置くと下辺と右辺が 1 つ内側へ寄り、
 * 辺の長さだけが正しいので**箱が閉じない**。
 *
 * **色は 5250 の属性バイトではない**（GRDATR 専用コード）。`decodeAttribute` に通すと
 * 全部緑になる。ホストの指定どおりの色・線種で描く（ACS は一律に青の実線で描くが、
 * それに合わせると DDS の書き手の指定を捨てることになる。既決事項）。
 */
function gridLineHtml(g: GuiGridLine): string {
  const color = GRID_COLOR[g.color] ?? "white";
  const cls = `gl c-${color} ${gridLineClass(g.lineStyle)}`.trim();
  const top = g.row - 1;
  const left = g.col - 1;
  const bottom = top + Math.max(1, g.height);
  const right = left + Math.max(1, g.width);
  const h = (b: number): string =>
    `<div class="${cls} gl-h" style="left:${X(left)};top:${Y(b)};width:${right - left}ch"></div>`;
  const v = (b: number): string =>
    `<div class="${cls} gl-v" style="left:${X(b)};top:${Y(top)};height:${(bottom - top) * 1.25}em"></div>`;

  // **単独罫線（0x00–0x03）は 2 つの数値の意味が箱と違う。**
  // 箱では「横罫の行間隔・縦罫の桁間隔」だが、GRDLIN では (繰り返し数, 間隔)。
  if (g.minorType <= 0x03) {
    const count = Math.max(1, g.value1);
    const step = g.value2;
    let out = "";
    for (let k = 0; k < count; k++) {
      if (g.minorType === 0x00) out += h(top + k * step); // 上辺
      else if (g.minorType === 0x01) out += h(bottom + k * step); // 下辺
      else if (g.minorType === 0x02) out += v(left + k * step); // 左辺
      else out += v(right + k * step); // 右辺
    }
    return out;
  }
  // 箱（0x04–0x07）。外周＋内部の等間隔罫線
  let out = h(top) + h(bottom) + v(left) + v(right);
  if (g.minorType === 0x05 || g.minorType === 0x07) {
    for (let r = top + g.value1; g.value1 > 0 && r < bottom; r += g.value1) out += h(r);
  }
  if (g.minorType === 0x06 || g.minorType === 0x07) {
    for (let c = left + g.value2; g.value2 > 0 && c < right; c += g.value2) out += v(c);
  }
  return out;
}

/**
 * 拡張 5250 の窓（枠と見出し）。文字で描かれた窓は cells に出るのでここでは扱わない。
 *
 * **ホストが送る位置は枠の左上で、中身はその 1 行下・3 桁右から始まる。** 宣言された
 * 位置をそのまま置くと実際の窓から左へ 1 桁ずれた矩形になる（web-ui の `windowStyle`
 * が既に `w.col + 1` で描いており、そちらが正しい）。枠の矩形は
 * 行 `row`〜`row+height+1` / 桁 `col+1`〜`col+width+4`。
 */
function windowHtml(w: GuiWindow): string {
  const top = w.row - 1;
  const left = w.col;
  const frame =
    `<div class="gwin" style="left:${X(left)};top:${Y(top)};` +
    `width:${w.width + 4}ch;height:${(w.height + 2) * 1.25}em"></div>`;
  if (!w.title) return frame;
  const cells = w.width + 4;
  const pad = Math.max(0, cells - w.title.text.length);
  const off = w.title.align === "left" ? 0 : w.title.align === "right" ? pad : Math.floor(pad / 2);
  const trow = w.title.footer ? top + w.height + 1 : top;
  return (
    frame +
    `<div class="gwt" style="left:${X(left + off)};top:${Y(trow)}">${esc(w.title.text)}</div>`
  );
}

/** 選択フィールド（ラジオ/チェック/プッシュボタン）。**押せない見た目**にする */
function selectionHtml(f: GuiSelectionField): string {
  const items = f.choices
    .map((c) => {
      const mark = f.kind === "radio" ? (c.selected ? "◉" : "○") : f.kind === "checkbox" ? (c.selected ? "☑" : "☐") : "";
      const cls = `gc${c.selected ? " sel" : ""}${c.available ? "" : " na"}`;
      return `<span class="${cls}">${mark ? esc(mark) : ""}${esc(c.text)}</span>`;
    })
    .join("");
  return `<div class="gsel ${f.kind}" style="left:${X(f.col - 1)};top:${Y(f.row - 1)}">${items}</div>`;
}

function guiHtml(gui: GuiConstructs | undefined): string {
  if (!gui) return "";
  let out = "";
  for (const g of gui.gridLines) out += gridLineHtml(g);
  for (const w of gui.windows) out += windowHtml(w);
  for (const f of gui.selectionFields) out += selectionHtml(f);
  for (const b of gui.scrollBars) {
    const cls = b.horizontal ? "gsb gsb-h" : "gsb gsb-v";
    out += `<div class="${cls}" style="left:${X(b.col - 1)};top:${Y(b.row - 1)}" title="${esc(
      `${b.sliderPos}/${b.total}`
    )}"></div>`;
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * 1 画面
 * ------------------------------------------------------------------ */

/**
 * **1 画面ぶんのマークアップ。単票も履歴もここを通る。**
 * 分けると 1 枚で見たときと履歴で見たときの絵が食い違い、証拠として使えなくなる。
 */
function screenFigure(snap: ScreenSnapshot, caption: string): string {
  const rows = snap.cells.map((r) => `<div class="ln">${renderRow(r)}</div>`).join("");
  const oia = [
    `<span>行/列 <b>${String(snap.cursor.row).padStart(2, "0")}/${String(snap.cursor.col).padStart(3, "0")}</b></span>`,
    `<span>画面 <b>${snap.rows}x${snap.cols}</b></span>`,
    snap.keyboardLocked ? `<span class="lock">🔒 応答待ち</span>` : `<span class="ok">入力可</span>`,
    snap.systemMessage ? `<span class="msg">${esc(snap.systemMessage)}</span>` : ""
  ].join("");
  return (
    `<figure class="scr" data-rows="${snap.rows}" data-cols="${snap.cols}">` +
    (caption ? `<figcaption>${caption}</figcaption>` : "") +
    `<div class="crt"><div class="grid" style="width:${snap.cols}ch">` +
    rows +
    cursorHtml(snap) +
    fieldsHtml(snap) +
    guiHtml(snap.gui) +
    `</div><div class="oia">${oia}</div></div></figure>`
  );
}

/* ------------------------------------------------------------------ *
 * ページの外枠
 * ------------------------------------------------------------------ */

/** メタ情報の行。値が無い項目は出さない（空欄を並べても読み手の役に立たない） */
function metaHtml(meta: ScreenHtmlMeta, extra: [string, string][] = []): string {
  const rows: [string, string][] = [];
  if (meta.capturedAt) rows.push(["取得日時", meta.capturedAt]);
  if (meta.sessionId) rows.push(["セッション", meta.sessionId]);
  if (meta.host) rows.push(["接続先", meta.host]);
  if (meta.job) rows.push(["ジョブ", meta.job]);
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
 * 端末の配色。`web-ui/src/styles.css` の実値を焼き込む（外部 CSS を参照しないため）。
 * 既定はダーク、`data-theme="light"` でペーパー調。
 */
const STYLE = `
:root{--bg:#0b0f0d;--fg:#c9d6cd;--card:#111815;--line:#22302a;--muted:#8ba396;
--crt:#050d09;--crt-bezel:#0c1710;--crt-line:#16281d;
--t-green:#3ddc84;--t-white:#e8f0e8;--t-red:#ff6161;--t-turquoise:#4dd8d8;
--t-yellow:#e8d44d;--t-pink:#ff8ad8;--t-blue:#6ea8ff;--t-glow:0 0 1px}
:root[data-theme=light]{--bg:#f4f6f2;--fg:#1f2937;--card:#fff;--line:#d3d9cf;--muted:#5b6b61;
--crt:#f7f8f4;--crt-bezel:#eceee8;--crt-line:#d3d9cf;
--t-green:#1a7f37;--t-white:#1f2937;--t-red:#c62828;--t-turquoise:#007c8a;
--t-yellow:#9a6b00;--t-pink:#c02679;--t-blue:#2456c4;--t-glow:0 0 0}
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
figure.scr{margin:0 0 12px}
figcaption{font-size:12px;color:var(--muted);margin-bottom:6px}
.crt{display:inline-block;background:var(--crt-bezel);border:1px solid var(--crt-line);
border-radius:8px;padding:10px}
/* **grid に padding を置かない。** 重ねる要素の top/left が padding box の角に揃うため、
   padding があると絶対配置だけ数 px ずれる（web-ui はその補正を各所に持っている）。
   最初から持たなければ、ずれる余地が無い。 */
.grid{position:relative;background:var(--crt);color:var(--t-green);
font-family:ui-monospace,"SFMono-Regular",Menlo,Consolas,"BIZ UDGothic","MS Gothic",monospace;
font-size:15px;line-height:1.25;white-space:pre}
.ln{height:1.25em}
/* 全角は必ず箱に入れて 2 桁を占めさせる（フォントに依らせない）。h は対を失った全角 */
.w,.h{display:inline-block;overflow:hidden;vertical-align:top;text-align:left}
.w{width:2ch}
.h{width:1ch}
/* 色は class ごとに --cell へも控える。**反転で currentColor を使ってはいけない**——
   同じルールで color を上書きすると currentColor がその新しい色に解決され、
   背景と文字が同色になって反転部分が消える（web-ui が --cell を持つのも同じ理由）。 */
.c-green{color:var(--t-green);--cell:var(--t-green)}
.c-white{color:var(--t-white);--cell:var(--t-white)}
.c-red{color:var(--t-red);--cell:var(--t-red)}
.c-turquoise{color:var(--t-turquoise);--cell:var(--t-turquoise)}
.c-yellow{color:var(--t-yellow);--cell:var(--t-yellow)}
.c-pink{color:var(--t-pink);--cell:var(--t-pink)}
.c-blue{color:var(--t-blue);--cell:var(--t-blue)}
.a-u{text-decoration:underline}
.a-r{background:var(--cell);color:var(--crt)}
.a-cs{border-left:1px solid var(--cell)}
.a-b{animation:bl 1s step-end infinite}
@keyframes bl{50%{opacity:.25}}
@media (prefers-reduced-motion:reduce){.a-b{animation:none}}
.cur,.fld,.gl,.gwin,.gwt,.gsel,.gsb{position:absolute;pointer-events:none}
.cur{width:1ch;height:1.25em;background:var(--t-white);opacity:.55}
.fld{height:1.25em;border-bottom:1px dotted var(--crt-line)}
.fld-p{border-bottom-style:none}
.gl-h{border-top:1px solid currentColor}
.gl-v{border-left:1px solid currentColor}
/* 線種は web-ui（ScreenGrid.vue の .grid-line）と同じ見え方に揃える */
.gl-h.gl-dotted{border-top-style:dotted}.gl-v.gl-dotted{border-left-style:dotted}
.gl-h.gl-dashed{border-top-style:dashed}.gl-v.gl-dashed{border-left-style:dashed}
.gl-h.gl-double{border-top-style:double;border-top-width:3px}
.gl-v.gl-double{border-left-style:double;border-left-width:3px}
.gl-h.gl-thick{border-top-width:2px}.gl-v.gl-thick{border-left-width:2px}
.gwin{border:1px solid var(--t-turquoise);border-radius:2px}
.gwt{color:var(--t-yellow);white-space:pre}
.gsel{display:flex;gap:4px}
.gc{border:1px solid var(--crt-line);padding:0 2px;border-radius:3px}
.gc.sel{box-shadow:inset 0 0 0 1px currentColor}
.gc.na{opacity:.45}
.gsb{width:1ch;height:1.25em;background:var(--crt-line)}
.frames{display:flex;gap:6px;flex-wrap:wrap;margin-bottom:10px;font-size:12px}
.frames button.on{outline:2px solid var(--t-green)}
[hidden]{display:none!important}
`;

/** テーマ切替（＋履歴版はナビ）。**JS はこれだけ。切っても画面は読める** */
const THEME_JS = `
var r=document.documentElement;
document.getElementById('t').onclick=function(){
  var d=r.getAttribute('data-theme')==='light';
  r.setAttribute('data-theme',d?'dark':'light');
  this.textContent=d?'☀ ライト':'🌙 ダーク';
};`;

const NAV_JS = `
var fs=[].slice.call(document.querySelectorAll('figure.scr'));
var bs=[].slice.call(document.querySelectorAll('.frames button'));
var i=0;
function show(n){
  i=Math.max(0,Math.min(fs.length-1,n));
  fs.forEach(function(f,k){f.hidden=k!==i});
  bs.forEach(function(b,k){b.className=k===i?'on':''});
  document.getElementById('p').disabled=i===0;
  document.getElementById('n').disabled=i===fs.length-1;
  document.getElementById('pos').textContent=(i+1)+' / '+fs.length;
}
document.getElementById('p').onclick=function(){show(i-1)};
document.getElementById('n').onclick=function(){show(i+1)};
bs.forEach(function(b,k){b.onclick=function(){show(k)}});
document.addEventListener('keydown',function(e){
  if(e.key==='ArrowLeft')show(i-1);
  if(e.key==='ArrowRight')show(i+1);
});
show(0);`;

function page(title: string, bodyHtml: string, js: string): string {
  return (
    `<!DOCTYPE html><html lang="ja"><head><meta charset="utf-8">` +
    `<meta name="viewport" content="width=device-width,initial-scale=1">` +
    `<title>${esc(title)}</title><style>${STYLE}</style></head><body>` +
    bodyHtml +
    `<script>${js}</script></body></html>`
  );
}

function header(title: string): string {
  return (
    `<header><h1>${esc(title)}</h1>` +
    `<button id="t" type="button">🌙 ダーク</button></header>`
  );
}

/* ------------------------------------------------------------------ *
 * 公開 API
 * ------------------------------------------------------------------ */

/**
 * 1 画面ぶんのエビデンス HTML。
 *
 * @param snap 画面スナップショット
 * @param meta 見出しに載せる情報（**日時は呼び出し側が渡す**。この関数は時計を持たない）
 */
export function renderScreenHtml(snap: ScreenSnapshot, meta: ScreenHtmlMeta = {}): string {
  const title = meta.title ?? "5250 画面";
  return page(title, header(title) + metaHtml(meta) + screenFigure(snap, ""), THEME_JS);
}

/**
 * 複数画面を 1 つにまとめ、前後にたどれるようにした完全版。
 *
 * **画面の描画は `renderScreenHtml` と同一**（どちらも `screenFigure()` を通る）。
 * ここが分かれると「1 枚で見たときと履歴で見たときで絵が違う」ことになり、
 * エビデンスとして成立しなくなる。
 */
export function renderScreenHistoryHtml(
  entries: readonly ScreenHistoryEntry[],
  meta: ScreenHtmlMeta = {}
): string {
  const title = meta.title ?? "5250 画面の履歴";
  if (entries.length === 0) {
    return page(title, header(title) + metaHtml(meta) + `<p>記録された画面がありません。</p>`, THEME_JS);
  }
  const label = (e: ScreenHistoryEntry, i: number): string =>
    `${i + 1}${e.key ? ` ${e.key}` : ""}`;
  const buttons = entries.map((e, i) => `<button type="button">${esc(label(e, i))}</button>`).join("");
  const figures = entries
    .map((e, i) => {
      const parts = [`${i + 1} / ${entries.length}`];
      if (e.key) parts.push(`送信キー: ${e.key}`);
      if (e.capturedAt) parts.push(e.capturedAt);
      if (e.note) parts.push(e.note);
      return screenFigure(e.screen, esc(parts.join("　·　")));
    })
    .join("");
  const nav =
    `<div class="frames">${buttons}</div>` +
    `<div class="frames"><button id="p" type="button">← 前</button>` +
    `<span id="pos"></span><button id="n" type="button">次 →</button></div>`;
  return page(
    title,
    header(title) + metaHtml(meta, [["コマ数", String(entries.length)]]) + nav + figures,
    THEME_JS + NAV_JS
  );
}
