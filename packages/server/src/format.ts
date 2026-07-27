import type { ScreenSnapshot, Cell, Field, GuiConstructs, ScreenColor } from "@as400web/core";

/**
 * 画面応答に含めるもの。
 * `grid` / `fields` / `attributes` はテキストのセクション、
 * **`ansi` だけは「色つきで描く」という描画指定**で、`screenToText` は無視する
 * （人向けの別ブロックとして `screenToAnsi` で出す。mcp-tools の `screenResult` が担当）。
 */
export type ScreenSection = "grid" | "fields" | "attributes" | "ansi";

export interface FormatOptions {
  /** 含めるセクション（既定: grid と fields の両方） */
  include?: ScreenSection[];
  /** グリッドの行範囲（1 始まり・両端含む）。省略時は全行 */
  rows?: { from: number; to: number };
}

/**
 * 表示属性が同じセルの連なり（1 始まり・`len` 桁）。
 * 画面 1 枚ぶんのセルを全部返すと大きすぎるので、**変わり目だけ**を返す。
 */
export interface AttrRun {
  row: number;
  col: number;
  len: number;
  color: ScreenColor;
  reverse?: boolean;
  underline?: boolean;
  blink?: boolean;
  columnSeparator?: boolean;
  nonDisplay?: boolean;
}

/**
 * 5250 の色 → ANSI の色番号（30 番台の前景色）。
 * 5250 の 7 色はどれも ANSI の基本 8 色に対応がある。青緑は cyan、ピンクは magenta。
 * 明るさは端末まかせ（太字 1 を足すと端末によって別色になるため足さない）。
 */
const ANSI_COLOR: Readonly<Record<ScreenColor, number>> = {
  green: 32,
  white: 37,
  red: 31,
  turquoise: 36,
  yellow: 33,
  pink: 35,
  blue: 34
};

/** そのセルを描くための SGR パラメータ */
function sgrOf(c: Cell): string {
  const p: number[] = [ANSI_COLOR[c.color]];
  // **5250 にセルごとの背景色は無い。** 属性が持つのは前景色と反転・下線・点滅・非表示・桁区切りだけで、
  // 「背景に色が付いて見える」のは反転（前景色と地色の入れ替え）。だから反転はそのまま 7 に写す
  if (c.reverse) p.push(7);
  if (c.underline) p.push(4);
  if (c.blink) p.push(5);
  return `\u001b[0;${p.join(";")}m`;
}

/** 属性を含めて 1 桁ぶんの表示文字を決める（非表示は伏せる） */
function visibleChar(c: Cell): string {
  if (c.nonDisplay) return " "; // ANSI の 8（conceal）は対応が乏しいので空白に倒す
  return c.char === "" ? " " : c.char;
}

/**
 * **画面を ANSI エスケープ付きのテキストにする（人が端末で見る用）。**
 *
 * 色・反転・下線・点滅をそのまま SGR に写す。桁区切り（CS）は ANSI に相当が無いので落とす
 * （落とすのは見た目の線だけで、`attributes` セクションには残る）。
 * 行頭で属性を初期化し、属性が変わった桁でだけエスケープを出す。
 */
export function screenToAnsi(snap: ScreenSnapshot, opts: FormatOptions = {}): string {
  const from = opts.rows?.from ?? 1;
  const to = opts.rows?.to ?? snap.rows;
  const out: string[] = [];
  for (let r = from; r <= to; r++) {
    const row = snap.cells[r - 1];
    if (!row) continue;
    let line = String(r).padStart(3) + "|";
    let cur = "";
    for (const c of row) {
      const sgr = sgrOf(c);
      if (sgr !== cur) {
        line += sgr;
        cur = sgr;
      }
      line += visibleChar(c);
    }
    out.push(line + "\u001b[0m");
  }
  return out.join("\n");
}

/**
 * **表示属性の変わり目を run で返す（LLM が読む用）。**
 *
 * 既定の見た目（緑・装飾なし）だけの連なりは落とす——画面の大半がそれなので、
 * 残すと「どこが強調されているか」が埋もれる。
 */
export function attributeRuns(snap: ScreenSnapshot, opts: FormatOptions = {}): AttrRun[] {
  const from = opts.rows?.from ?? 1;
  const to = opts.rows?.to ?? snap.rows;
  const plain = (c: Cell): boolean =>
    c.color === "green" && !c.reverse && !c.underline && !c.blink && !c.columnSeparator && !c.nonDisplay;
  const key = (c: Cell): string =>
    `${c.color}|${c.reverse}|${c.underline}|${c.blink}|${c.columnSeparator}|${c.nonDisplay}`;

  const runs: AttrRun[] = [];
  for (let r = from; r <= to; r++) {
    const row = snap.cells[r - 1];
    if (!row) continue;
    let start = 0;
    for (let i = 0; i <= row.length; i++) {
      const c = row[i];
      const head = row[start];
      if (i < row.length && head && key(c!) === key(head)) continue;
      if (head && !plain(head)) {
        const run: AttrRun = { row: r, col: start + 1, len: i - start, color: head.color };
        if (head.reverse) run.reverse = true;
        if (head.underline) run.underline = true;
        if (head.blink) run.blink = true;
        if (head.columnSeparator) run.columnSeparator = true;
        if (head.nonDisplay) run.nonDisplay = true;
        runs.push(run);
      }
      start = i;
    }
  }
  return runs;
}

/**
 * ScreenSnapshot を LLM 可読の固定テキスト形式にする（spec「MCP テキスト画面形式」）。
 * cells をそのまま平坦化するため SO/SI・属性桁も 1 桁保持され、桁位置がテキスト上でもズレない。
 */
export function screenToText(snap: ScreenSnapshot, opts: FormatOptions = {}): string {
  const include = new Set<ScreenSection>(opts.include ?? ["grid", "fields"]);
  const out: string[] = [];

  out.push(
    `=== Screen ${snap.rows}x${snap.cols}  cursor=(${snap.cursor.row},${snap.cursor.col})  ` +
      `keyboard=${snap.keyboardLocked ? "locked" : "unlocked"} ===`
  );

  if (include.has("grid")) {
    const from = opts.rows?.from ?? 1;
    const to = opts.rows?.to ?? snap.rows;
    for (let r = from; r <= to; r++) {
      const row = snap.cells[r - 1];
      if (!row) continue;
      // DBCS tail セル（char=""）は空白で埋めて桁位置を保つ（1 桁=1 文字。SO/SI は既に空白）
      out.push(String(r).padStart(3) + "|" + row.map((c) => (c.char === "" ? " " : c.char)).join(""));
    }
  }

  if (snap.systemMessage) out.push(`=== Message ===\n${snap.systemMessage}`);

  if (include.has("fields")) {
    out.push("=== Fields ===");
    if (snap.fields.length === 0) out.push("(none)");
    for (const f of snap.fields) out.push(fieldLine(f));
  }

  if (include.has("attributes")) {
    const runs = attributeRuns(snap, opts);
    out.push("=== Attributes ===");
    if (runs.length === 0) out.push("(none)");
    for (const a of runs) {
      const marks = [
        a.reverse ? "reverse" : "",
        a.underline ? "underline" : "",
        a.blink ? "blink" : "",
        a.columnSeparator ? "colsep" : "",
        a.nonDisplay ? "nondisplay" : ""
      ].filter(Boolean);
      out.push(
        `(${a.row},${a.col}) len=${a.len} ${a.color}` + (marks.length > 0 ? ` ${marks.join(" ")}` : "")
      );
    }
  }

  if (snap.gui) out.push(...guiLines(snap.gui));

  return out.join("\n");
}

/** GUI 構造体（拡張 5250）を LLM 可読テキストに。選択肢は選択状態・可否を明示する */
function guiLines(gui: GuiConstructs): string[] {
  const out: string[] = ["=== GUI ==="];
  for (const s of gui.selectionFields) {
    out.push(`selection #${s.id} (${s.row},${s.col}) ${s.kind}${s.multiple ? " multi" : ""}`);
    for (const c of s.choices) {
      const marks = [c.selected ? "[x]" : "[ ]", c.available ? "" : "(unavailable)"].filter(Boolean).join(" ");
      out.push(`  ${c.index}. ${marks} ${JSON.stringify(c.text)}`);
    }
  }
  for (const w of gui.windows) {
    const title = w.title ? ` "${w.title}"` : "";
    out.push(`window #${w.id} (${w.row},${w.col}) ${w.width}x${w.height}${title}`);
  }
  for (const b of gui.scrollBars) {
    out.push(
      `scrollbar #${b.id} (${b.row},${b.col}) ${b.horizontal ? "horizontal" : "vertical"} ` +
        `pos=${b.sliderPos}/${b.total} size=${b.size}`
    );
  }
  return out;
}

function fieldLine(f: Field): string {
  const attrs = [
    f.protected ? "protected" : "input",
    f.hidden ? "hidden" : "",
    f.numeric ? "numeric" : "",
    f.mdt ? "modified" : ""
  ]
    .filter(Boolean)
    .join(" ");
  const value = f.hidden ? "(masked)" : JSON.stringify(f.value);
  return `#${f.index} (${f.row},${f.col}) len=${f.length} ${attrs} value=${value}`;
}
