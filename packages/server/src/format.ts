import type { ScreenSnapshot, Field, GuiConstructs } from "@as400web/core";

export type ScreenSection = "grid" | "fields";

export interface FormatOptions {
  /** 含めるセクション（既定: grid と fields の両方） */
  include?: ScreenSection[];
  /** グリッドの行範囲（1 始まり・両端含む）。省略時は全行 */
  rows?: { from: number; to: number };
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
