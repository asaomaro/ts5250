import { describe, it, expect } from "vitest";
import { mount } from "@vue/test-utils";
import ScreenGrid from "../src/components/ScreenGrid.vue";
import type { ScreenSnapshot, Cell, Field } from "@as400web/core";

/**
 * セル選択（オーバーレイ）と native キャレットの二重表示を防ぐ。
 *
 * 画面遷移直後、ホストが報告するカーソルは (1,1) のまま入力欄へ初期フォーカスが入ることがある
 * （STRPDM のようにコマンド入力欄へ飛ぶ画面）。カーソル位置だけで判定していたため、
 * 左上にセル選択が出たままになっていた。
 */
function cell(char: string): Cell {
  return {
    char,
    kind: "sbcs",
    color: "green",
    reverse: false,
    underline: false,
    blink: false,
    columnSeparator: false,
    nonDisplay: false
  };
}

/** カーソルは (1,1)＝非入力セル。入力欄は別の場所にある */
function snap(fields: Field[]): ScreenSnapshot {
  const cells: Cell[][] = [];
  for (let r = 0; r < 24; r++) cells.push(Array.from({ length: 80 }, () => cell(" ")));
  return {
    sessionId: "s",
    rows: 24,
    cols: 80,
    cursor: { row: 1, col: 1 },
    keyboardLocked: false,
    cells,
    fields
  };
}

const FIELDS: Field[] = [
  { index: 1, row: 20, col: 8, length: 20, protected: false, hidden: false, numeric: false, mdt: false, value: "" }
];

describe("セル選択と入力欄のフォーカスは二重に出さない", () => {
  it("カーソルが非入力セルでも、入力欄にフォーカスがあればセル選択を出さない", async () => {
    const w = mount(ScreenGrid, { props: { snapshot: snap(FIELDS), edits: new Map(), focused: true } });
    // 初期状態: カーソル (1,1) は非入力セルなのでオーバーレイが出る
    expect(w.find(".cursor").exists()).toBe(true);

    // 入力欄へフォーカスが入った（画面遷移直後の初期フォーカス相当）
    await w.find("input.grid-input").trigger("focusin");
    expect(w.find(".cursor").exists()).toBe(false);
    w.unmount();
  });

  it("入力欄からフォーカスが外れればセル選択に戻る", async () => {
    const w = mount(ScreenGrid, { props: { snapshot: snap(FIELDS), edits: new Map(), focused: true } });
    const input = w.find("input.grid-input");
    await input.trigger("focusin");
    expect(w.find(".cursor").exists()).toBe(false);

    await input.trigger("focusout", { relatedTarget: null });
    expect(w.find(".cursor").exists()).toBe(true);
    w.unmount();
  });

  it("入力欄が無い画面ではセル選択が出る（従来どおり）", () => {
    const w = mount(ScreenGrid, { props: { snapshot: snap([]), edits: new Map(), focused: true } });
    expect(w.find(".cursor").exists()).toBe(true);
    w.unmount();
  });
});
