import { describe, it, expect } from "vitest";
import { mount } from "@vue/test-utils";
import ScreenGrid from "../src/components/ScreenGrid.vue";
import type { Cell, ScreenSnapshot } from "@as400web/tn5250";
import { isFullWidth } from "../src/composables/fieldValidate.js";

/**
 * **相方を失った DBCS セルは 1 桁で描く（ACS 準拠）。**
 *
 * 5250 の全角は lead（前半）＋ tail（後半）の 2 桁を占める。ホストが**既に全角が書かれている桁に
 * 属性バイトや別のデータを重ねて書く**と、片割れだけが残る。実機では、Attn の
 * 「コマンド入力」窓が 23 桁目から重なることで、背面 19 行目「選択項目またはコマンド」の
 * 最後の「ド」（22〜23 桁）の tail が潰され、lead だけが残った。
 *
 * ACS はこれを 1 桁ぶんに切り詰めて描く（分断された見た目になる）。2 桁ぶん描いてしまうと
 * 隣の桁を侵し、**以降の見た目が 1 桁ずれる**——それが直したい不具合。
 */

const COLS = 20;
const ROWS = 2;

function cell(over: Partial<Cell> = {}): Cell {
  return {
    char: " ",
    kind: "sbcs",
    color: "green",
    reverse: false,
    underline: false,
    blink: false,
    columnSeparator: false,
    nonDisplay: false,
    ...over
  } as Cell;
}

/** 1 行ぶんのセル列から 2 行のスナップショットを作る（2 行目は空） */
function snapOf(first: Cell[]): ScreenSnapshot {
  const row = [...first];
  while (row.length < COLS) row.push(cell());
  const blank = Array.from({ length: COLS }, () => cell());
  return {
    sessionId: "s",
    rows: ROWS,
    cols: COLS,
    cursor: { row: 1, col: 1 },
    keyboardLocked: false,
    cells: [row.slice(0, COLS), blank],
    fields: []
  } as unknown as ScreenSnapshot;
}

function mountGrid(snapshot: ScreenSnapshot) {
  return mount(ScreenGrid, {
    props: { snapshot, edits: new Map(), focused: false, busy: false, cursor: { row: 1, col: 1 } }
  });
}

/**
 * 1 行目が実際に占める**画面上の桁数**。
 * 素のランの中の全角は**フォントが 2 桁で描く**ので 2 と数える（ここを 1 で数えると、
 * 桁溢れという不具合そのものを見逃す）。wide は 2 桁固定、half は 1 桁固定。
 */
function renderedColumns(w: ReturnType<typeof mountGrid>): number {
  const row = w.element.querySelectorAll(".grid-row")[0]!;
  let n = 0;
  for (const el of row.querySelectorAll(".grid-span")) {
    if (el.classList.contains("wide-cell")) n += 2;
    else if (el.classList.contains("half-cell")) n += 1;
    else for (const ch of el.textContent ?? "") n += isFullWidth(ch) ? 2 : 1;
  }
  return n;
}

describe("相方を失った DBCS セル", () => {
  it("tail を属性に潰された lead は 1 桁に切り詰めて描く（2 桁ぶん占有しない）", () => {
    // 「あ」の lead(1桁目) + tail(2桁目) …だったところへ、ホストが 2 桁目に属性を書いた形
    const row = [
      cell({ char: "あ", kind: "dbcs-lead" }),
      cell({ kind: "attr" }), // ← tail が潰された
      cell({ char: "A" })
    ];
    const w = mountGrid(snapOf(row));
    expect(w.findAll(".half-cell")).toHaveLength(1);
    expect(w.findAll(".wide-cell")).toHaveLength(0);
    expect(renderedColumns(w)).toBe(COLS); // 桁が溢れない＝以降がずれない
  });

  it("lead を潰された tail も 1 桁ぶんを占有する（桁を詰めない）", () => {
    const row = [
      cell({ kind: "attr" }), // ← lead が潰された
      cell({ char: "", kind: "dbcs-tail" }),
      cell({ char: "A" })
    ];
    const w = mountGrid(snapOf(row));
    expect(w.findAll(".half-cell")).toHaveLength(1);
    expect(renderedColumns(w)).toBe(COLS);
  });

  it("対になっている通常の全角は従来どおり 2 桁で描く（half にしない）", () => {
    const row = [
      cell({ char: "あ", kind: "dbcs-lead" }),
      cell({ char: "", kind: "dbcs-tail" }),
      cell({ char: "A" })
    ];
    const w = mountGrid(snapOf(row));
    expect(w.findAll(".half-cell")).toHaveLength(0);
    expect(renderedColumns(w)).toBe(COLS);
  });

  it("切り詰めたセルにも反転・下線が乗る", () => {
    const row = [
      cell({ char: "あ", kind: "dbcs-lead", reverse: true, underline: true }),
      cell({ kind: "attr" })
    ];
    const w = mountGrid(snapOf(row));
    const half = w.find(".half-cell");
    expect(half.exists()).toBe(true);
    expect(half.classes().join(" ")).toMatch(/rev|under/);
  });

  it("行末の lead（次の桁が無い）も 1 桁に切り詰める", () => {
    const row = Array.from({ length: COLS - 1 }, () => cell());
    row.push(cell({ char: "あ", kind: "dbcs-lead" }));
    const w = mountGrid(snapOf(row));
    expect(w.findAll(".half-cell")).toHaveLength(1);
    expect(renderedColumns(w)).toBe(COLS);
  });

  /**
   * 実機の再現形。「…コマンド」の最後の全角の tail が窓の左端の属性で潰された行。
   * 直す前は lead が 2 桁ぶん描かれて 1 桁溢れる。
   */
  it("実機の再現形（窓が全角の途中に重なった行）で桁が溢れない", () => {
    const row: Cell[] = [
      cell({ char: "コ", kind: "dbcs-lead" }),
      cell({ char: "", kind: "dbcs-tail" }),
      cell({ char: "マ", kind: "dbcs-lead" }),
      cell({ char: "", kind: "dbcs-tail" }),
      cell({ char: "ン", kind: "dbcs-lead" }),
      cell({ char: "", kind: "dbcs-tail" }),
      cell({ char: "ド", kind: "dbcs-lead" }), // 7 桁目
      cell({ kind: "attr", reverse: true }) // 8 桁目＝窓の左端。ド の tail を潰した
    ];
    const w = mountGrid(snapOf(row));
    expect(renderedColumns(w)).toBe(COLS);
    expect(w.findAll(".half-cell")).toHaveLength(1);
    expect(w.findAll(".wide-cell").length).toBeGreaterThanOrEqual(0);
  });
});
