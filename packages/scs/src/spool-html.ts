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
import type { ShiftMark } from "./scs.js";
// **フォントの候補は画面 HTML と共有する**（`@ts5250/base`）——2 か所に書くと候補がずれる
import { EVIDENCE_FONTS, evidenceFontIndex } from "@ts5250/base";

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
   * SO/SI マークの**開いたときの見せ方**（既定 `none`＝非表示）。
   *
   * 非表示 → 薄目 → 濃目 をページ内で順送りできる（画面 HTML と同じ 3 値）。印は桁を
   * 占めない（桁の境目に重ねて描く）ので、**どの状態でも桁は 1 つも動かない**。
   */
  shiftMarks?: ShiftMarkView;
  /** 表示コード切替（カナ ⇄ 英）。渡すと両方の読みを HTML に入れる */
  sbcs?: SpoolSbcsToggle;
  /** 開いたときのフォント（`EVIDENCE_FONTS` の id。既定は先頭＝標準） */
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
 * SO/SI マークの見せ方。非表示／薄目／濃目（画面 HTML・web-ui の画面設定と同じ 3 値）。
 * **濃目もふつうの文字より薄い**——本物の `{ }` と区別が付かなくなると色を分けた意味が消える。
 */
export type ShiftMarkView = "none" | "dim" | "strong";

/** SO/SI の順送りの順（既定を先頭に置く） */
const SOSI_VIEWS = ["none", "dim", "strong"] as const;

/** 切り替えラベルに出す名前 */
const SOSI_LABELS: Record<ShiftMarkView, string> = {
  none: "非表示",
  dim: "薄目",
  strong: "濃目"
};

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
 * - SO/SI の印は**文字の流れに挟まず、桁の境目に重ねて置く**。印は幅を持たないので、
 *   出しても消しても桁は 1 つも動かない（`markHtml` の注記）
 */
function renderLine(
  line: string,
  raw: readonly (number | undefined)[],
  shifts: readonly ShiftMark[],
  alt: SbcsReading | undefined
): string {
  const body = reportLineSegs(line, raw, alt)
    .map((seg: ReportSeg) => {
      if (seg.kind === "wide") return `<span class="w">${esc(seg.text)}</span>`;
      return seg.alt === undefined
        ? esc(seg.text)
        : `<span class="va">${esc(seg.text)}</span><span class="vb">${esc(seg.alt)}</span>`;
    })
    .join("");
  return body + shifts.map(markHtml).join("");
}

/**
 * SO/SI の印。**桁を占めない**——`position:absolute` で桁の境目に重ね、幅は持たせない。
 *
 * 文字の流れに挟むと、印を出した行だけ右へずれる。実採取の帳票（PUB400 の Library List）で
 * 確かめたとおり、**SO/SI に桁を与えると DBCS の行だけ 1 桁ずれて他の行と食い違う**
 * ——ホストは SO/SI が桁を占めない前提で桁を組んでいる。だから重ねて描くしかない。
 *
 * `left` は桁の境目（`col - 1` 桁ぶん）。`ch` は**この要素自身のフォント**で解決されるので、
 * ここで字の大きさを変えないこと（変えると位置がずれる）。
 */
function markHtml(m: ShiftMark): string {
  return `<span class="so" style="left:${m.col - 1}ch">${m.kind === "so" ? "{" : "}"}</span>`;
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
/**
 * ページ送りの規則。**枚数に比例して増える**が、その代わり JS が 1 行も要らない
 * ——配るエビデンスなので、読み手の環境（JS 無効・CSP）に依存しないほうを採る。
 */
function pageCss(n: number): string {
  return Array.from({ length: n }, (_, i) =>
    `#pg${i}:checked ~ .page figure.pg[data-page="${i + 1}"]{display:block}\n` +
    `#pg${i}:checked ~ .page label[for=pg${i}]{outline:2px solid var(--fg)}`
  ).join("\n");
}

const FONT_CSS = EVIDENCE_FONTS.map(
  (f, i) =>
    `#g${i}:checked ~ .page .sheet{--sheet-mono:${f.stack}}\n` +
    `#g${i}:checked ~ .page label[for=g${(i + 1) % EVIDENCE_FONTS.length}]{display:inline-flex}`
).join("\n");

const TOGGLE_CSS = `
.fw{display:none}
.tg{position:absolute;width:1px;height:1px;opacity:0;margin:0;pointer-events:none}
/* 2 値のボタンは両方の字を入れておき、**素の状態のほうだけ**を出す。
   ここを .btn>span で一括に隠すと、変化部分を固定幅の箱（.tv）に入れた
   SO/SI の語まで消える——実際に消えて「現在の状態が出ない」になった（利用者の指摘）。
   隠すのは .st-on だけでよい。
   ※ここは STYLE のテンプレートリテラル内。バッククォートは書けない。 */
.btn>.st-on{display:none}
/* **トグルで変化する部分は固定幅にする。** 押すたびに字数が変わると
   ボタンの幅が変わり、後ろのボタンが左右に動く（利用者の指摘）。
   変化する部分だけを固定幅の箱に入れれば、状態が変わっても幅は同じ。
   web-ui のヘッダー（App.vue の .tv）と同じ手。
   **フォント名だけは固定できない**——候補も字数も環境で変わるので、
   その 1 つだけを一番右に置いて、幅が変わっても後続に響かないようにしてある。 */
.tv{display:inline-block;text-align:left;white-space:nowrap}
.tv.theme{width:5.4em}
.tv.sosi{width:3.2em}
.tv.kana{width:2.4em}
#t:checked ~ .page label[for=t]>.st-off,#k:checked ~ .page label[for=k]>.st-off{display:none}
#t:checked ~ .page label[for=t]>.st-on,#k:checked ~ .page label[for=k]>.st-on{display:inline-block}
/* SO/SI は 3 値。ラベル i は「今が状態 i」のときだけ見え、押すと次へ進む
   ＝ボタン 1 つが 非表示 → 薄目 → 濃目 と回る（画面 HTML と同じ作り） */
.sw{display:none}
#s0:checked ~ .page label[for=s1],
#s1:checked ~ .page label[for=s2],
#s2:checked ~ .page label[for=s0]{display:inline-flex}
/* ページ送り。**JS を使わない**——ラジオ 1 つが 1 ページに対応し、押した番号のページだけ出す。
   ラジオなので、束にフォーカスすれば矢印キーでページを送れる（前は JS でやっていた）。 */
figure.pg{display:none}
.nav label.jump.on{outline:2px solid var(--fg)}
/* 表示コード: 必ず片方だけが出るので桁は動かない */
.sheet .vb{display:none}
#k:checked ~ .page .sheet .va{display:none}
#k:checked ~ .page .sheet .vb{display:inline}
/* SO/SI: **桁を占めない**。桁の境目に重ねて置き、幅は持たせない（markHtml の注記。
   ここは STYLE のテンプレートリテラル内なのでバッククォートは書けない）
   ——出しても消しても桁が 1 つも動かないのはこのため。
   本物の { } と見分けが付くよう淡く描き、本文ではないので選択・コピーにも混ぜない。 */
.ln{position:relative}
.so{display:none;position:absolute;top:0;width:1ch;margin-left:-.5ch;text-align:center;
pointer-events:none;user-select:none;-webkit-user-select:none}
#s1:checked ~ .page .so{display:inline-block;
color:color-mix(in srgb,var(--ink) 30%,var(--paper))}
#s2:checked ~ .page .so{display:inline-block;
color:color-mix(in srgb,var(--ink) 65%,var(--paper))}
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
 * スプール 1 件ぶんのエビデンス HTML。
 *
 * @param pages 論理ページ（`SpoolReport.pages`／`ScsDecoder` の出力）
 * @param meta 見出しに載せる情報（**日時は呼び出し側が渡す**）
 */
/** 状態を出すラベル（`st-off` が素の状態、`st-on` がチェック済みの状態） */
function toggleLabel(id: string, off: string, on: string, tv: string, prefix = ""): string {
  return (
    `<label class="btn" for="${id}">${esc(prefix)}` +
    `<span class="st-off tv ${tv}">${esc(off)}</span>` +
    `<span class="st-on tv ${tv}">${esc(on)}</span></label>`
  );
}

/**
 * フォントの順送りボタン。**ラベル i は「今が候補 i」のときだけ見え、押すと次へ進む**
 * ——見えているのは常に 1 つなので、利用者にはボタン 1 つが回っているように見える。
 */
function fontLabels(): string {
  return EVIDENCE_FONTS.map(
    (f, i) =>
      `<label class="btn fw" for="g${(i + 1) % EVIDENCE_FONTS.length}">フォント: ${esc(f.label)}</label>`
  ).join("");
}

/**
 * SO/SI の順送りボタン。**ラベル i は「今が状態 i」のときだけ見え、押すと次の状態に進む**
 * ——見えているのは常に 1 つなので、利用者にはボタン 1 つが回っているように見える。
 */
function sosiLabels(): string {
  return SOSI_VIEWS.map(
    (v, i) =>
      `<label class="btn sw" for="s${(i + 1) % SOSI_VIEWS.length}">` +
      `SO/SI <span class="tv sosi">${SOSI_LABELS[v]}</span></label>`
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
  const fontIdx = evidenceFontIndex(style.font);
  const body =
    `<header><h1>${esc(title)}</h1>` +
    // **フォントは一番右**（`.tv` の注記）。候補名の幅は環境で変わるので、
    // 後ろに何も置かなければ幅が変わっても他のボタンは動かない。
    toggleLabel("t", "☀ 通常", "🌙 ダーク", "theme") +
    // 出す桁が無い帳票には出さない（押しても何も起きない部品を置かない）
    (showSosi ? sosiLabels() : "") +
    (showSbcs && style.sbcs
      ? toggleLabel(
          "k",
          SBCS_LABELS[style.sbcs.host],
          SBCS_LABELS[otherReading(style.sbcs.host)],
          "kana",
          "表示コード: "
        )
      : "") +
    fontLabels() +
    `</header>` +
    metaHtml(meta, [["ページ数", String(pages.length)]]) +
    // ページ送りはラジオのラベル。**押せる部品は置くが JS は持たない**
    `<div class="nav">` +
    list.map((_, i) => `<label class="btn jump" for="pg${i}">${i + 1}</label>`).join("") +
    `</div>` +
    list.map((p, i) => pageFigure(p, i, list.length, showSbcs ? alt : undefined)).join("");
  return (
    `<!DOCTYPE html><html lang="ja"><head><meta charset="utf-8">` +
    `<meta name="viewport" content="width=device-width,initial-scale=1">` +
    // ページ送りの規則は枚数で決まるので、ここで足す（`pageCss` の注記）
    `<title>${esc(title)}</title><style>${STYLE}${pageCss(list.length)}</style></head><body>` +
    `<input class="tg" type="checkbox" id="t">` +
    EVIDENCE_FONTS.map(
      (_, i) => `<input class="tg" type="radio" name="g" id="g${i}"${i === fontIdx ? " checked" : ""}>`
    ).join("") +
    // ページ 1 枚につきラジオ 1 つ（束にフォーカスすれば矢印キーで送れる）
    list
      .map((_, i) => `<input class="tg" type="radio" name="pg" id="pg${i}"${i === 0 ? " checked" : ""}>`)
      .join("") +
    (showSosi
      ? SOSI_VIEWS.map(
          (v, i) =>
            `<input class="tg" type="radio" name="s" id="s${i}"${
              v === (style.shiftMarks ?? "none") ? " checked" : ""
            }>`
        ).join("")
      : "") +
    (showSbcs && style.sbcs
      ? `<input class="tg" type="checkbox" id="k"${
          (style.sbcs.initial ?? style.sbcs.host) !== style.sbcs.host ? " checked" : ""
        }>`
      : "") +
    `<div class="page">` +
    body +
    `</div></body></html>`
  );
}
