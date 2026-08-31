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
} from "./screen/types.js";
import { GRID_COLOR, GRID_LINE_STYLE } from "./protocol/wdsf-parser.js";
// **サブパスから取る**（`browser.ts` の注記）。変換表は純粋だが重く、
// 入口ごと引き込むとブラウザ向けの束が太る。
import { katakanaChar, latinChar } from "@ts5250/ebcdic/katakana";
// **候補は帳票 HTML と共有する**（`@ts5250/base`）——2 か所に書くと候補がずれる
import { EVIDENCE_FONTS, evidenceFontIndex } from "@ts5250/base";

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

/**
 * **描き方の指定**（メタ情報＝見出しに載る事実とは別物なので分けて受ける）。
 */
export interface ScreenHtmlStyle {
  /**
   * SO/SI マークの**開いたときの見せ方**（既定 `none`＝非表示）。
   *
   * **非表示 → 薄目 → 濃目 はページ内で順送りできる**（CSS だけのトグル。`TOGGLE_CSS` 参照）
   * ので、ここで決まるのは初期状態だけ。web-ui は画面と同じ状態で開くために渡す。
   */
  shiftMarks?: ShiftMarkView;

  /**
   * **表示コードの切り替え**（カナ ⇄ 英）を付ける。
   *
   * 渡すと、SBCS の生バイトを**もう一方の表で読み直した字も HTML に入れ**、
   * ページ内で差し替えられるようにする（CSS だけのトグル。`TOGGLE_CSS` 参照）。
   * 読み直しても字が 1 つも変わらない画面には切り替えを出さない。
   */
  sbcs?: SbcsToggle;

  /**
   * 開いたときのフォント（`EVIDENCE_FONTS` の id。既定は先頭＝標準）。
   *
   * **ページ内で候補を順送りできる**（CSS だけのトグル）ので、ここで決まるのは初期状態だけ。
   * web-ui は画面と同じ字で開くために渡す。
   */
  font?: string;
}

/**
 * 表示コード切替の指定。
 *
 * **切り替えとは「もう一方の表で読み直すこと」**——CCSID 930 の SBCS 部（CP290）と
 * 939 の SBCS 部（CP1027）はカタカナと英小文字の位置が入れ替わった鏡像である
 * （web-ui の `KanaView` と同じ考え方）。
 */
export interface SbcsToggle {
  /**
   * **そのまま描いた字がどちらの読みか。** ホストの CCSID を知っているのは呼び出し側だけなので
   * ここで受け取る。こちらは「もう一方」を生バイトから作るだけ。
   */
  host: SbcsReading;
  /** 開いたときにどちらを見せるか（既定は `host`＝ホストが返した字そのまま） */
  initial?: SbcsReading;
}

/** SBCS の読み。カナ（CP290 系）／英（CP1027 系） */
export type SbcsReading = "kana" | "latin";

/** 切り替えラベルに出す名前（web-ui の画面設定「表示コード」と同じ言葉） */
const SBCS_LABELS: Record<SbcsReading, string> = { kana: "カナ", latin: "英" };

/** もう一方の読み */
function otherReading(r: SbcsReading): SbcsReading {
  return r === "kana" ? "latin" : "kana";
}

/**
 * SO/SI マークの見せ方。非表示／薄目／濃目（web-ui の画面設定「SO/SI 表示」と同じ 3 値）。
 *
 * **濃目もふつうの文字より薄い**——桁の色そのままにすると本物の `{ }` と区別が付かず、
 * 色を分けた意味が消える。薄目は淡すぎて読み取りにくい環境があるので、その中間を用意する。
 */
export type ShiftMarkView = "none" | "dim" | "strong";

/** SO/SI の順送りの順（web-ui の ctrl+F3 と同じ。既定を先頭に置く） */
const SOSI_VIEWS = ["none", "dim", "strong"] as const;

/** 切り替えラベルに出す名前（web-ui の画面設定と同じ言葉） */
const SOSI_LABELS: Record<ShiftMarkView, string> = {
  none: "非表示",
  dim: "薄目",
  strong: "濃目"
};

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
 * **SO/SI 桁にマークを描くか。**
 *
 * マークは**常に HTML に入れておき、見せるかどうかは CSS のトグルで決める**（`TOGGLE_CSS`）。
 * `{ }` はホストのデータにある本物の `{ }` と同じ字なので、色を分けないと**どちらが制御桁か
 * 分からない**（web-ui の `.a-shift` と同じ意図。淡色は `.a-so`）。
 *
 * 非表示（nonDisplay）桁には描かない——ACS は非表示属性の桁に何も描かない（web-ui の
 * `displayChar` と同じ規則）。
 */
function isShiftCell(c: Cell): boolean {
  return (c.kind === "so" || c.kind === "si") && !c.nonDisplay;
}

/** SO/SI 桁に出す字。**セルの `char` は見ない**——制御桁なので中身は無く、印はこちらで決める */
function shiftMarkChar(c: Cell): string {
  return c.kind === "so" ? "{" : "}";
}

/** その画面に SO/SI 桁があるか（**無ければトグルを出さない**＝押しても何も起きない部品を置かない） */
function hasShiftCells(snap: ScreenSnapshot): boolean {
  return snap.cells.some((row) => row.some(isShiftCell));
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

/**
 * その桁を**指定した読みで**描いたときの字。
 *
 * 読み直せるのは **`kind` が `sbcs` で生バイトを持つ桁だけ**（web-ui の `recodes` と同じ条件）。
 * **`rawByte` があることは条件にならない**——属性桁も `rawByte`（属性バイト）を載せている
 * （web-ui が編集の種値を作るのに要る）。それを読み直すと 0x20〜0x3F が C0/C1 の制御文字に
 * 化け、欄の先頭ごとに豆腐（□）が並ぶ（利用者の報告）。
 *
 * 読み直した結果が制御文字になることは、生の SBCS バイトでも起こりうる。
 * **描けない字は半角スペースにする**——ACS と同じで、web-ui の `displayText` と同じ扱い。
 * 非表示桁も伏せたまま——読みを変えても伏せる約束は変わらない。
 */
function cellCharAs(c: Cell, reading: SbcsReading): string {
  if (c.nonDisplay || c.kind !== "sbcs" || c.rawByte === undefined) return cellChar(c);
  const ch = reading === "kana" ? katakanaChar(c.rawByte) : latinChar(c.rawByte);
  return displayableChar(ch);
}

/**
 * 描けない字を半角スペースに落とす。
 *
 * 対象は制御文字（C0 / DEL / C1）と、表にマップが無いことを表す U+FFFD。そのまま出すと
 * フォント次第で豆腐（□）になり、U+FFFD は**多くのフォントで全角幅**なので 1 桁のはずが
 * 2 桁を占めて行末までずれる（web-ui の `displayText` に同じ注記がある）。
 */
function displayableChar(ch: string): string {
  const c = ch.codePointAt(0);
  if (c === undefined) return " ";
  return c < 0x20 || (c >= 0x7f && c <= 0x9f) || c === 0xfffd ? " " : ch;
}

/**
 * 読み直すと字が変わる桁があるか（**無ければ切り替えを出さない**＝
 * 押しても何も起きない部品を置かない。`hasShiftCells` と同じ方針）。
 */
function hasSbcsAlt(snap: ScreenSnapshot, alt: SbcsReading): boolean {
  return snap.cells.some((row) => row.some((c) => cellCharAs(c, alt) !== cellChar(c)));
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
function renderRow(row: readonly Cell[], alt: SbcsReading | undefined): string {
  let out = "";
  let runCls = "";
  let runText = "";
  let runAlt = "";
  /** いまの連なりが「読みで字が変わる」側か。**変わる／変わらないの境目で連なりを切る** */
  let runDiff = false;
  /**
   * **二重に出すのは、読みで字が変わる区間だけ。**
   *
   * 属性が同じでも**読み替わるかどうかが変わる位置で連なりを切る**ので、
   * 空白・数字・英大文字（＝画面の大半。どちらの表でも同じ位置）は 1 つのまま残る。
   * 切らずに連なりごと二重化すると、行に 1 文字カナがあるだけで行全体が 2 倍になる。
   *
   * 出し分けは `display` で 1 つだけ見せる——**必ず片方が出ている**ので桁は動かない
   * （SO/SI の印は「出ない状態」があるから箱を残す必要があり、あちらとは事情が違う）。
   */
  const flush = (): void => {
    if (runText === "") return;
    if (runDiff) {
      out +=
        `<span class="${runCls} va">${esc(runText)}</span>` +
        `<span class="${runCls} vb">${esc(runAlt)}</span>`;
    } else {
      out += `<span class="${runCls}">${esc(runText)}</span>`;
    }
    runText = "";
    runAlt = "";
  };
  for (let i = 0; i < row.length; i++) {
    const c = row[i]!;
    const cls = cellClass(c);
    // SO/SI 桁は**必ず自分の span に切り出す**——見せ隠しを CSS のトグルでやるため。
    // 隠すのは字の色だけなので箱は残り、**桁は 1 つも動かない**（`.a-so` の注記）。
    if (isShiftCell(c)) {
      flush();
      out += `<span class="${cls} a-so">${shiftMarkChar(c)}</span>`;
      continue;
    }
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
    const text = cellChar(c);
    const altText = alt === undefined ? text : cellCharAs(c, alt);
    const diff = altText !== text;
    if (cls !== runCls || diff !== runDiff) {
      flush();
      runCls = cls;
      runDiff = diff;
    }
    runText += text;
    runAlt += altText;
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

/**
 * ブロックカーソル。**全角の上では 2 桁ぶんを覆う**——ACS は DBCS 1 文字ぜんぶに
 * カーソルが当たる。1 桁だけ塗ると「文字の左半分に載っている」ように見える。
 * tail に載ったときは lead から覆う（同じ 1 文字なので見え方を変えない）。
 * 対を失った全角は表示自体が 1 桁なので 1 桁のまま（web-ui の `cursorBox` と同じ規則）。
 */
function cursorHtml(snap: ScreenSnapshot): string {
  const { row, col } = snap.cursor;
  if (row < 1 || col < 1 || row > snap.rows || col > snap.cols) return "";
  const cells = snap.cells[row - 1];
  const here = cells?.[col - 1];
  let left = col - 1;
  let cols = 1;
  if (here?.kind === "dbcs-lead" && cells?.[col]?.kind === "dbcs-tail") cols = 2;
  else if (here?.kind === "dbcs-tail" && cells?.[col - 2]?.kind === "dbcs-lead") {
    left = col - 2;
    cols = 2;
  }
  return `<div class="cur" style="left:${X(left)};top:${Y(row - 1)};width:${cols}ch"></div>`;
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
function screenFigure(snap: ScreenSnapshot, caption: string, alt: SbcsReading | undefined): string {
  const rows = snap.cells.map((r) => `<div class="ln">${renderRow(r, alt)}</div>`).join("");
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
 * **表示の切り替えを JS 無しで作る。**
 *
 * チェックボックスと `:checked ~`（一般兄弟結合子）だけで動くので、**JS を切っても・
 * CSP で script を止められても切り替えが生きる**。エビデンスとして配る HTML なので、
 * 読み手の環境に依存する部分は少ないほうがいい。
 *
 * 状態を持つ `<input>` は**本文（`.page`）より前**に置く必要がある——CSS は先祖にも前の
 * 兄弟にも遡れず、辿れるのは後ろの兄弟だけだから。入力そのものは画面に出さないが、
 * `display:none` にすると Tab 順から外れてキーボードで押せなくなるので、1px に潰して隠す。
 *
 * ラベルは**今の状態**を出す（従来のテーマボタンと同じ流儀）。CSS は字を差し替えられないので、
 * 2 値（テーマ）は両方の字を入れて `:checked` で出し分け、3 値（SO/SI）は**状態の数だけ
 * ラベルを置いて 1 つだけ見せる**。
 *
 * **3 値の順送りはラジオで作る。** ラベル i は「今が状態 i」のときだけ見え、押すと次の状態の
 * ラジオが入る（`for` が次を指す）——つまり**ボタン 1 つが 非表示 → 薄目 → 濃目 → 非表示 と
 * 回る**。web-ui の画面設定（ctrl+F3 の順送り）と同じ回り方なので、保存した HTML でも
 * 画面と同じ 3 値が選べる。
 */
const FONT_CSS = EVIDENCE_FONTS.map(
  (f, i) =>
    `#g${i}:checked ~ .page{--mono:${f.stack}}\n` +
    `#g${i}:checked ~ .page label[for=g${(i + 1) % EVIDENCE_FONTS.length}]{display:inline-flex}`
).join("\n");

const TOGGLE_CSS = `
.tg{position:absolute;width:1px;height:1px;opacity:0;margin:0;pointer-events:none}
/* フォントは 3 値以上なので SO/SI と同じ順送り（ボタン 1 つが候補を一巡する） */
.fw{display:none}
#t:focus-visible ~ .page label[for=t],
#k:focus-visible ~ .page label[for=k],
#s0:focus-visible ~ .page label[for=s1],
#s1:focus-visible ~ .page label[for=s2],
#s2:focus-visible ~ .page label[for=s0]{outline:2px solid var(--t-green);outline-offset:1px}
/* 2 値のボタンは両方の字を入れておき、**素の状態のほうだけ**を出す。
   ここを .btn>span で一括に隠すと、変化部分を固定幅の箱（.tv）に入れた
   SO/SI の語まで消える——実際に消えて「現在の状態が出ない」になった（利用者の指摘）。
   隠すのは .st-on だけでよい。
   ※ここは STYLE のテンプレートリテラル内。バッククォートは書けない。 */
.btn>.st-on{display:none}
/* **トグルで変化する部分は固定幅にする。** 押すたびに字数が変わると
   ボタンの幅が変わり、**後ろのボタンが左右に動く**（利用者の指摘）。
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
/* 表示コードの出し分け。**必ず片方だけが出る**ので桁は動かない。
   .ln span が (0,1,1) なので、打ち消す側はクラス 2 つ (0,2,0) で書く。 */
.ln .vb{display:none}
#k:checked ~ .page .ln .va{display:none}
#k:checked ~ .page .ln .vb{display:inline-block}
.sw{display:none}
#s0:checked ~ .page label[for=s1],
#s1:checked ~ .page label[for=s2],
#s2:checked ~ .page label[for=s0]{display:inline-flex}
#s1:checked ~ .page .a-so{text-decoration-color:currentColor;
color:color-mix(in srgb,var(--cell,currentColor) 30%,var(--crt))}
#s1:checked ~ .page .a-r .a-so,#s1:checked ~ .page .a-r.a-so{
color:color-mix(in srgb,var(--crt) 30%,var(--cell))}
#s2:checked ~ .page .a-so{text-decoration-color:currentColor;
color:color-mix(in srgb,var(--cell,currentColor) 65%,var(--crt))}
#s2:checked ~ .page .a-r .a-so,#s2:checked ~ .page .a-r.a-so{
color:color-mix(in srgb,var(--crt) 65%,var(--cell))}
`;

/**
 * 端末の配色。`web-ui/src/styles.css` の実値を焼き込む（外部 CSS を参照しないため）。
 * 既定はダーク、`#t`（テーマのチェックボックス）を入れるとペーパー調。
 *
 * **明色の変数は `:root` ではなく `.page` に置く。** チェックボックスから `:root` は辿れない
 * （CSS は先祖へ遡れない）が、**後ろの兄弟**なら `~` で辿れるので、本文をまるごと `.page` に
 * 入れてそこへ被せる。`body` は `:root` のダークのままなので、地色は `.page` が自分で塗る
 * （`min-height:100vh` で画面いっぱいを覆う）。
 */
const STYLE = `
:root{--bg:#0b0f0d;--fg:#c9d6cd;--card:#111815;--line:#22302a;--muted:#8ba396;
--crt:#050d09;--crt-bezel:#0c1710;--crt-line:#16281d;
--t-green:#3ddc84;--t-white:#e8f0e8;--t-red:#ff6161;--t-turquoise:#4dd8d8;
--t-yellow:#e8d44d;--t-pink:#ff8ad8;--t-blue:#6ea8ff;--t-glow:0 0 1px;
--mono:ui-monospace,"SFMono-Regular",Menlo,Consolas,"BIZ UDGothic","MS Gothic",monospace}
#t:checked ~ .page{--bg:#f4f6f2;--fg:#1f2937;--card:#fff;--line:#d3d9cf;--muted:#5b6b61;
--crt:#f7f8f4;--crt-bezel:#eceee8;--crt-line:#d3d9cf;
--t-green:#1a7f37;--t-white:#1f2937;--t-red:#c62828;--t-turquoise:#007c8a;
--t-yellow:#9a6b00;--t-pink:#c02679;--t-blue:#2456c4;--t-glow:0 0 0}
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
figure.scr{margin:0 0 12px}
figcaption{font-size:12px;color:var(--muted);margin-bottom:6px}
.crt{display:inline-block;background:var(--crt-bezel);border:1px solid var(--crt-line);
border-radius:8px;padding:10px}
/* **grid に padding を置かない。** 重ねる要素の top/left が padding box の角に揃うため、
   padding があると絶対配置だけ数 px ずれる（web-ui はその補正を各所に持っている）。
   最初から持たなければ、ずれる余地が無い。 */
.grid{position:relative;background:var(--crt);color:var(--t-green);
font-family:var(--mono);
font-size:15px;line-height:1.25;white-space:pre}
.ln{height:1.25em}
/* 全角は必ず箱に入れて 2 桁を占めさせる（フォントに依らせない）。h は対を失った全角 */
.w,.h{overflow:hidden;text-align:left}
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
/* **文字ランは行送りぶんの箱にする**（web-ui の .grid-span と同じ考え方）。
   素のインライン要素は内容領域（フォントの ascent+descent）にしか背景を塗らないので、
   反転が縦に続くと行間に地色の隙間が横線として並ぶ。box-shadow 等で固定量を足す手は
   **内容領域が広いフォントで隣の行へはみ出す**（実測: Noto Sans Mono CJK JP で
   行送り 18.75px に対し塗り 25px）。必要な量はフォントごとに違い CSS から読めないため、
   箱そのものを行送りに合わせる。vertical-align:top と height は対で必要。 */
.a-r{background:var(--cell);color:var(--crt)}
/* SO/SI マークの既定は**隠す**。見せるのは #s1/#s2:checked（TOGGLE_CSS）。
   **隠すのは字の色だけ。** visibility:hidden は箱ごと消えるので、背景色の付いた桁
   （反転）では**背景まで消えていた**（利用者の報告）。桁区切りの罫線も同じ理由で消える。
   反転・下線・桁区切りは**制御桁そのものの見た目**であって印の一部ではないから、
   印を出していないときも残す——web-ui がそこに空白 1 桁を描くのと同じ絵になる。
   下線は色に連動する（text-decoration-color の既定は currentColor）ので、隠している間は
   桁の色で引き直す。display:none は桁が詰まるので、どの状態でも使えない。
   user-select:none は web-ui に合わせる——マークは制御桁の印であってデータではないので、
   選択してコピーした文字列に混ぜない。 */
.a-so{color:transparent;text-decoration-color:var(--cell,currentColor);
user-select:none;-webkit-user-select:none}
.ln span{display:inline-block;height:1.25em;vertical-align:top}
.a-cs{border-left:1px solid var(--cell)}
.a-b{animation:bl 1s step-end infinite}
@keyframes bl{50%{opacity:.25}}
@media (prefers-reduced-motion:reduce){.a-b{animation:none}}
.cur,.fld,.gl,.gwin,.gwt,.gsel,.gsb{position:absolute;pointer-events:none}
/* 幅は要素側の style が決める（全角の上では 2ch）。ここは既定 */
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
/* 画面下の状態行（OIA）。web-ui の StatusBar と同じ実値。
   **項目の区切りは gap で作る。** 規則が無かった頃は素の inline のまま並び、
   「行/列 01/001画面 24x80入力可」と繋がって読めなかった（利用者の指摘）。
   区切り文字を挟まないのは、ここが桁の絵ではなく**注記**だからで、
   折り返しても崩れない間隔のほうが素直に効く。
   ※ここは STYLE のテンプレートリテラル内。バッククォートは書けない。 */
.oia{display:flex;align-items:center;gap:12px;flex-wrap:wrap;padding:5px 10px;
font-family:var(--mono);font-size:11px;color:var(--muted);
background:var(--crt-bezel);border-top:1px solid var(--crt-line)}
.oia b{color:var(--t-green)}
.lock{color:var(--t-yellow)}
.msg{color:var(--t-red)}
.frames{display:flex;gap:6px;flex-wrap:wrap;margin-bottom:10px;font-size:12px}
.frames button.on{outline:2px solid var(--t-green)}
[hidden]{display:none!important}
${TOGGLE_CSS}${FONT_CSS}`;

/**
 * 履歴のコマ送り。**JS はこれだけになった**（テーマ切替と SO/SI 表示は CSS だけで動く）。
 *
 * ここを CSS にしないのは、コマ数ぶんのラベルと規則を並べることになり、
 * **ページ数に比例して HTML と CSS が膨らむ**ため。単票は JS ゼロで出る。
 */
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

/** ページに置く切り替え。`sosi` はその画面に SO/SI 桁があるときだけ true にする */
interface Toggles {
  sosi: boolean;
  /** SO/SI マークの初期状態（ページ内で順送りできるので、決まるのは開いたときだけ） */
  sosiView: ShiftMarkView;
  /** 表示コードの切り替え。読み直しても字が変わらない画面では出さない */
  sbcs: SbcsToggle | undefined;
  /** 開いたときのフォント（`EVIDENCE_FONTS` の位置） */
  fontIdx: number;
}

/**
 * ページの外枠。**状態を持つ `<input>` は `.page` の前**に置く（`TOGGLE_CSS` の注記）。
 *
 * `js` が空なら `<script>` を出さない——単票は切り替えを CSS で作ったので JS が要らない。
 */
function page(title: string, bodyHtml: string, js: string, tg: Toggles): string {
  return (
    `<!DOCTYPE html><html lang="ja"><head><meta charset="utf-8">` +
    `<meta name="viewport" content="width=device-width,initial-scale=1">` +
    `<title>${esc(title)}</title><style>${STYLE}</style></head><body>` +
    `<input class="tg" type="checkbox" id="t">` +
    EVIDENCE_FONTS.map(
      (_, i) =>
        `<input class="tg" type="radio" name="g" id="g${i}"${i === tg.fontIdx ? " checked" : ""}>`
    ).join("") +
    // 3 値は**状態の数だけラジオ**を置く（1 つのボタンで順送りするため。`TOGGLE_CSS`）
    (tg.sosi
      ? SOSI_VIEWS.map(
          (v, i) =>
            `<input class="tg" type="radio" name="s" id="s${i}"${v === tg.sosiView ? " checked" : ""}>`
        ).join("")
      : "") +
    // 表示コードは 2 値なのでチェックボックス 1 つ（素＝ホストの読み、入れると もう一方）
    (tg.sbcs
      ? `<input class="tg" type="checkbox" id="k"${
          (tg.sbcs.initial ?? tg.sbcs.host) !== tg.sbcs.host ? " checked" : ""
        }>`
      : "") +
    `<div class="page">` +
    bodyHtml +
    `</div>` +
    (js ? `<script>${js}</script>` : "") +
    `</body></html>`
  );
}

/**
 * 状態を出すラベル（`st-off` が素の状態、`st-on` がチェック済みの状態）。
 *
 * `prefix` は状態で変わらない部分、`tv` は**変化する部分を入れる固定幅の箱**の種類。
 * 分けているのは、押すたびに幅が変わって後ろのボタンが動くのを避けるため（`.tv` の注記）。
 */
function toggleLabel(id: string, off: string, on: string, tv: string, prefix = ""): string {
  return (
    `<label class="btn" for="${id}">${prefix}` +
    `<span class="st-off tv ${tv}">${off}</span><span class="st-on tv ${tv}">${on}</span></label>`
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

function header(title: string, tg: Toggles): string {
  return (
    `<header><h1>${esc(title)}</h1>` +
    // **フォントは一番右**（`.tv` の注記）。候補名の幅は環境で変わるので、
    // 後ろに何も置かなければ幅が変わっても他のボタンは動かない。
    toggleLabel("t", "🌙 ダーク", "☀ ライト", "theme") +
    // SO/SI 桁が 1 つも無い画面には出さない（押しても何も起きない部品を置かない）
    (tg.sosi ? sosiLabels() : "") +
    (tg.sbcs
      ? toggleLabel(
          "k",
          SBCS_LABELS[tg.sbcs.host],
          SBCS_LABELS[otherReading(tg.sbcs.host)],
          "kana",
          "表示コード: "
        )
      : "") +
    fontLabels() +
    `</header>`
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
export function renderScreenHtml(
  snap: ScreenSnapshot,
  meta: ScreenHtmlMeta = {},
  style: ScreenHtmlStyle = {}
): string {
  const title = meta.title ?? "5250 画面";
  const alt = style.sbcs ? otherReading(style.sbcs.host) : undefined;
  const tg: Toggles = {
    sosi: hasShiftCells(snap),
    sosiView: style.shiftMarks ?? "none",
    sbcs: alt !== undefined && hasSbcsAlt(snap, alt) ? style.sbcs : undefined,
    fontIdx: evidenceFontIndex(style.font)
  };
  // 単票は切り替えを CSS で作ったので **`<script>` を出さない**
  return page(title, header(title, tg) + metaHtml(meta) + screenFigure(snap, "", alt), "", tg);
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
  meta: ScreenHtmlMeta = {},
  style: ScreenHtmlStyle = {}
): string {
  const title = meta.title ?? "5250 画面の履歴";
  const alt = style.sbcs ? otherReading(style.sbcs.host) : undefined;
  const tg: Toggles = {
    sosi: entries.some((e) => hasShiftCells(e.screen)),
    sosiView: style.shiftMarks ?? "none",
    sbcs:
      alt !== undefined && entries.some((e) => hasSbcsAlt(e.screen, alt)) ? style.sbcs : undefined,
    fontIdx: evidenceFontIndex(style.font)
  };
  if (entries.length === 0) {
    return page(title, header(title, tg) + metaHtml(meta) + `<p>記録された画面がありません。</p>`, "", tg);
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
      return screenFigure(e.screen, esc(parts.join("　·　")), alt);
    })
    .join("");
  const nav =
    `<div class="frames">${buttons}</div>` +
    `<div class="frames"><button id="p" type="button">← 前</button>` +
    `<span id="pos"></span><button id="n" type="button">次 →</button></div>`;
  return page(
    title,
    header(title, tg) + metaHtml(meta, [["コマ数", String(entries.length)]]) + nav + figures,
    NAV_JS,
    tg
  );
}
