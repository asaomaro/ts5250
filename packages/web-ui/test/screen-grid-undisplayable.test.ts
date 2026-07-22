import { describe, it, expect } from "vitest";
import { mount } from "@vue/test-utils";
import ScreenGrid from "../src/components/ScreenGrid.vue";
import type { ScreenSnapshot, Cell, Field } from "@as400web/core";

/**
 * **表示できない SBCS は半角スペースで出す（ACS と同じ）。**
 *
 * EBCDIC の SBCS 表にはマップの無いバイトがあり、コーデックはそこを U+FFFD で返す。
 * そのまま出すと多くのフォントで U+FFFD が全角幅になり、1 桁のはずが 2 桁を占めて
 * その行の後続がすべて右へずれる。表示コードページの切り替え（930 カナ表と 1027 表で
 * 未定義バイトの集合が違う）で実際に現れた。
 */
function cell(char: string, extra: Partial<Cell> = {}): Cell {
  return {
    char,
    kind: "sbcs",
    color: "green",
    reverse: false,
    underline: false,
    blink: false,
    columnSeparator: false,
    nonDisplay: false,
    ...extra
  };
}

function snapWith(chars: string[]): ScreenSnapshot {
  const cells: Cell[][] = [];
  for (let r = 0; r < 24; r++) {
    const row: Cell[] = [];
    for (let c = 0; c < 80; c++) row.push(cell(" "));
    cells.push(row);
  }
  chars.forEach((ch, i) => {
    cells[0]![i] = cell(ch);
  });
  return {
    sessionId: "s",
    rows: 24,
    cols: 80,
    cursor: { row: 1, col: 1 },
    keyboardLocked: false,
    cells,
    fields: []
  };
}

describe("表示できない SBCS（U+FFFD）", () => {
  it("画面テキストでは半角スペースになる（桁がずれない）", () => {
    const w = mount(ScreenGrid, {
      props: { snapshot: snapWith(["A", "�", "B"]), edits: new Map(), focused: true }
    });
    const text = w.findAll(".grid-row")[0]!.text();
    expect(text).not.toContain("�");
    expect(text.startsWith("A B")).toBe(true);
  });

  it("入力欄の中でも半角スペースになる", () => {
    const snapshot = snapWith(["A", "�", "B"]);
    const field: Field = {
      index: 1,
      row: 1,
      col: 1,
      length: 3,
      protected: true,
      hidden: false,
      numeric: false,
      mdt: false,
      value: "A�B"
    };
    snapshot.fields = [field];
    const w = mount(ScreenGrid, { props: { snapshot, edits: new Map(), focused: true } });
    const v = (w.find("input.grid-input").element as HTMLInputElement).value;
    expect(v).not.toContain("�");
    expect(v.startsWith("A B")).toBe(true);
  });
});

/**
 * **表示の置き換えがモデルへ逆流しないこと。**
 *
 * 表示は U+FFFD を空白にするが、ホストへ送る値は元の文字のまま保たれなければならない。
 * 置き換えが逆流すると、その欄を編集しただけで別の文字（空白）に化けて送信されてしまう。
 * 置換は 1 文字 1 文字（長さ不変）なので、桁とキャレットの対応も崩れない。
 */
describe("表示の置き換えは編集値に影響しない", () => {
  const editable: Field = {
    index: 1,
    row: 1,
    col: 1,
    length: 3,
    protected: false,
    hidden: false,
    numeric: false,
    mdt: false,
    value: "A�B"
  };

  it("末尾を打ち替えても U+FFFD は元の桁に残る（空白に化けない）", async () => {
    const snapshot = snapWith(["A", "�", "B"]);
    snapshot.fields = [editable];
    const w = mount(ScreenGrid, { props: { snapshot, edits: new Map(), focused: true } });
    const input = w.find("input.grid-input");
    const el = input.element as HTMLInputElement;

    await input.trigger("focus");
    el.setSelectionRange(2, 2); // U+FFFD の次（3 桁目）
    await input.trigger("keydown", { key: "X" });

    const emits = w.emitted("edit") as [number, string][] | undefined;
    expect(emits, "編集が発火する").toBeTruthy();
    expect(emits!.at(-1)![1]).toBe("A�X"); // 表示は "A X" でも送る値は元の文字
  });

  it("表示（DOM の value）は空白で、桁数は変わらない", async () => {
    const snapshot = snapWith(["A", "�", "B"]);
    snapshot.fields = [editable];
    const w = mount(ScreenGrid, { props: { snapshot, edits: new Map(), focused: true } });
    const el = w.find("input.grid-input").element as HTMLInputElement;
    expect(el.value).toBe("A B");
    expect(el.value).toHaveLength(editable.value.length); // 1:1 置換なのでキャレット桁が保たれる
  });
});
