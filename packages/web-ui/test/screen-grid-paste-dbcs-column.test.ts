import { describe, it, expect } from "vitest";
import { mount } from "@vue/test-utils";
import ScreenGrid from "../src/components/ScreenGrid.vue";
import { columnView, isFullWidth } from "../src/composables/fieldValidate.js";
import type { ScreenSnapshot, Cell, Field } from "@as400web/core";

/**
 * **複数行ペーストの宛先は画面桁。DBCS 欄でも桁がずれない。**
 *
 * 宛先は画面桁で引くのに、書き込みは論理文字の配列（全角＝1 要素・SO/SI＝0 要素）で行うため、
 * 欄の先頭に全角があるとその桁ぶんだけ貼り付け位置が右へずれていた。行ごとに全角の数が違うと
 * 行ごとに違う量ずれ、矩形が崩れる（先頭の全角が無い行だけ正しい位置に入っていた）。
 */
function cell(char = " "): Cell {
  return {
    char, kind: "sbcs", color: "green", reverse: false, underline: false,
    blink: false, columnSeparator: false, nonDisplay: false
  };
}

function snap(fields: Field[]): ScreenSnapshot {
  const cells: Cell[][] = [];
  for (let r = 0; r < 24; r++) {
    const row: Cell[] = [];
    for (let c = 0; c < 80; c++) row.push(cell());
    cells.push(row);
  }
  return { sessionId: "s", rows: 24, cols: 80, cursor: { row: 1, col: 13 }, keyboardLocked: false, cells, fields };
}

/** 行 row の 1 桁目から 20 桁の DBCS(open) 欄 */
function fld(index: number, row: number): Field {
  return {
    index, row, col: 1, length: 20,
    protected: false, hidden: false, numeric: false, dbcsType: "open", mdt: false, value: ""
  };
}

/** 列ビュー内の index が画面の何桁目か（SO/SI＝1 桁・全角＝2 桁） */
function colOfViewIndex(view: string, idx: number): number {
  let col = 1;
  for (const ch of view.slice(0, idx)) col += isFullWidth(ch) ? 2 : 1;
  return col;
}

/** 画面桁 col に当たる列ビューの index */
function viewIndexOfCol(view: string, col: number): number {
  let c = 1;
  let i = 0;
  for (const ch of view) {
    if (c === col) return i;
    c += isFullWidth(ch) ? 2 : 1;
    i++;
  }
  return -1;
}

/** 論理値の中で最後に現れる word が、画面の何桁目から始まるか（SO/SI＝1 桁・全角＝2 桁） */
function lastWordCol(logical: string, word: string): number {
  const view = columnView(logical, " ", " ");
  const at = view.lastIndexOf(word);
  if (at < 0) return -1;
  let col = 1;
  for (const ch of view.slice(0, at)) col += isFullWidth(ch) ? 2 : 1;
  return col;
}

describe("DBCS 欄への複数行ペースト", () => {
  it("先頭の全角の数が行ごとに違っても、貼り付け位置は指定した桁に揃う", () => {
    const edits = new Map([
      [1, "１    AAA"], // 先頭に全角 1 文字（SO/SI 込みで 4 桁）
      [2, "１２ BBB"], // 先頭に全角 2 文字（SO/SI 込みで 6 桁）
      [3, "       CCC"] // 全角なし
    ]);
    const w = mount(ScreenGrid, {
      props: { snapshot: snap([fld(1, 1), fld(2, 2), fld(3, 3)]), edits, focused: true },
      attachTo: document.body
    });

    // 矩形 "AAA/BBB/CCC" を 1 行目の 13 桁目へ貼る（各行の同じ桁へ落ちるのが ACS）
    (w.vm as unknown as { pasteAt: (r: number, c: number, t: string) => void }).pasteAt(1, 13, "AAA\nBBB\nCCC");

    const emitted = (w.emitted("edit") ?? []) as [number, string][];
    const valueOf = (idx: number): string => [...emitted].reverse().find((e) => e[0] === idx)![1];

    expect(lastWordCol(valueOf(1), "AAA")).toBe(13);
    expect(lastWordCol(valueOf(2), "BBB")).toBe(13);
    expect(lastWordCol(valueOf(3), "CCC")).toBe(13);
    w.unmount();
  });

  it("貼り付け前の内容は動かない（上書きされた桁だけが変わる）", () => {
    const edits = new Map([[1, "１    AAA"]]);
    const w = mount(ScreenGrid, {
      props: { snapshot: snap([fld(1, 1)]), edits, focused: true },
      attachTo: document.body
    });
    (w.vm as unknown as { pasteAt: (r: number, c: number, t: string) => void }).pasteAt(1, 13, "ZZZ");
    const emitted = (w.emitted("edit") ?? []) as [number, string][];
    const value = [...emitted].reverse().find((e) => e[0] === 1)![1];
    expect(value.startsWith("１    AAA")).toBe(true); // 元の内容はそのまま
    expect(lastWordCol(value, "ZZZ")).toBe(13);
    w.unmount();
  });

  /**
   * ペースト後もカーソルは開始桁から動かない（ACS）。DBCS 欄では **開始桁は「桁」・
   * `edit.cursor` は「論理インデックス」**で座標系が違い、桁をそのまま入れると
   * カーソルが貼り付けた文字列の末尾側へ流れていた。
   */
  it("フォーカス欄へ貼ってもカーソルは開始桁から動かない", async () => {
    const edits = new Map([[1, "１    AAA"], [2, "１２ BBB"], [3, "       CCC"]]);
    const w = mount(ScreenGrid, {
      props: { snapshot: snap([fld(1, 1), fld(2, 2), fld(3, 3)]), edits, focused: true },
      attachTo: document.body
    });
    const input = w.findAll("input.grid-input")[0]!;
    const el = input.element as HTMLInputElement;
    await input.trigger("focus");
    el.setSelectionRange(viewIndexOfCol(el.value, 13), viewIndexOfCol(el.value, 13));
    await input.trigger("click");

    await input.trigger("paste", { clipboardData: { getData: () => "AAA\nBBB\nCCC" } });

    expect(colOfViewIndex(el.value, el.selectionStart ?? -1)).toBe(13); // 開始桁のまま
    w.unmount();
  });

  /**
   * 貼り付け先の全角を潰す場合も、**上書きは後続の桁を動かさない**（打鍵と同じ規則）。
   * 全角 1 文字（SO/SI 込みで 4 桁）を半角 1 文字で潰すと 3 桁余るため、調整しないと
   * その先の文字が左へ詰まる（DBCS を潰していない行だけ元の位置を保っていた）。
   */
  it("先頭の全角を潰して貼っても、その先の文字は元の桁に残る", () => {
    const edits = new Map([
      [1, "１    AAA"], // AAA は 9 桁目から
      [2, "１２ BBB"], // BBB は 8 桁目から
      [3, "       CCC"] // CCC は 8 桁目から（全角なし）
    ]);
    const w = mount(ScreenGrid, {
      props: { snapshot: snap([fld(1, 1), fld(2, 2), fld(3, 3)]), edits, focused: true },
      attachTo: document.body
    });

    // 全角の手前（1 桁目）へ矩形を貼る＝先頭の全角を潰す
    (w.vm as unknown as { pasteAt: (r: number, c: number, t: string) => void }).pasteAt(1, 1, "AAA\nBBB\nCCC");

    const emitted = (w.emitted("edit") ?? []) as [number, string][];
    const valueOf = (idx: number): string => [...emitted].reverse().find((e) => e[0] === idx)![1];

    // 貼った側は 1 桁目から、元からあった語は元の桁のまま
    for (const [idx, word] of [[1, "AAA"], [2, "BBB"], [3, "CCC"]] as const) {
      expect(valueOf(idx).startsWith(word)).toBe(true);
    }
    expect(lastWordCol(valueOf(1), "AAA")).toBe(9);
    expect(lastWordCol(valueOf(2), "BBB")).toBe(8);
    expect(lastWordCol(valueOf(3), "CCC")).toBe(8);
    w.unmount();
  });
});
