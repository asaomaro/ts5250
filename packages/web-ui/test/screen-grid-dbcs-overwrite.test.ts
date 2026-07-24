import { describe, it, expect } from "vitest";
import { mount } from "@vue/test-utils";
import ScreenGrid from "../src/components/ScreenGrid.vue";
import { isFullWidth } from "../src/composables/fieldValidate.js";
import type { ScreenSnapshot, Cell, Field } from "@as400web/core";

/**
 * **DBCS 欄の上書き入力は後続の桁を動かさない（ACS 相当）。**
 *
 * 全角を半角で潰すと 2 桁が 1 桁になり、ランの最後の全角を潰すと SO/SI の 2 桁も消える。
 * 縮んだぶんを埋めないと離れた桁の文字まで左へ詰まる——`{あいうえお}    #` を 3 桁目から
 * 半角空白で消していくと、消し切った時点で 20 桁目の `#` が 13 桁目（＝全角 5 桁ぶん＋SO/SI 2 桁）
 * へ動いていた。
 */
function cell(char = " ", extra: Partial<Cell> = {}): Cell {
  return {
    char, kind: "sbcs", color: "green", reverse: false, underline: false,
    blink: false, columnSeparator: false, nonDisplay: false, ...extra
  };
}

function snap(fields: Field[]): ScreenSnapshot {
  const cells: Cell[][] = [];
  for (let r = 0; r < 24; r++) {
    const row: Cell[] = [];
    for (let c = 0; c < 80; c++) row.push(cell());
    cells.push(row);
  }
  return { sessionId: "s1", rows: 24, cols: 80, cursor: { row: 2, col: 3 }, keyboardLocked: false, cells, fields };
}

/** 欄 (2,3) 20 桁の DBCS(open)。論理値 "あいうえお    #" → 列ビュー "{あいうえお}    #" */
const FIELD: Field = {
  index: 1, row: 2, col: 3, length: 20,
  protected: false, hidden: false, numeric: false, dbcsType: "open", mdt: false, value: ""
};

/** 列ビュー文字列で ch が何桁目に見えるか（全角＝2 桁・SO/SI＝1 桁） */
function colOf(view: string, ch: string): number {
  let col = 1;
  for (const c of view) {
    if (c === ch) return col;
    col += isFullWidth(c) ? 2 : 1;
  }
  return -1;
}

function mountWith(logical: string, length = FIELD.length) {
  const w = mount(ScreenGrid, {
    props: { snapshot: snap([{ ...FIELD, length }]), edits: new Map([[1, logical]]), focused: true },
    attachTo: document.body
  });
  return { w, input: w.find("input.grid-input") };
}

describe("DBCS 欄の上書きは桁位置を保つ", () => {
  it("全角を半角空白で潰していっても、離れた桁の文字は動かない", async () => {
    const { w, input } = mountWith("あいうえお    #");
    await input.trigger("focus");
    const el = input.element as HTMLInputElement;
    const before = colOf(el.value, "#");
    expect(before).toBe(17); // SO(1)+全角 5(10)+SI(1)+空白 4 の次

    el.setSelectionRange(0, 0); // 欄の先頭（SO の桁）から
    for (let i = 0; i < 14; i++) await input.trigger("keydown", { key: " " });

    expect(el.value.trim()).toBe("#"); // 全角は消えた
    expect(colOf(el.value, "#")).toBe(before); // 桁は動かない
    w.unmount();
  });

  it("全角 1 文字を半角 1 文字で潰すと、その全角の 2 桁ぶんが空くだけ", async () => {
    const { w, input } = mountWith("あい#");
    await input.trigger("focus");
    const el = input.element as HTMLInputElement;
    const before = colOf(el.value, "#");
    el.setSelectionRange(0, 0);
    await input.trigger("keydown", { key: "A" });
    expect(colOf(el.value, "#")).toBe(before); // 'あ' の 2 桁は 'A' ＋空白 1 桁で埋まる
    expect(el.value).toContain("A");
    expect(el.value).toContain("い");
    w.unmount();
  });

  it("挿入モードは従来どおり（後続が右へずれる）", async () => {
    const { w, input } = mountWith("あい#");
    await input.trigger("focus");
    const el = input.element as HTMLInputElement;
    const before = colOf(el.value, "#");
    el.setSelectionRange(0, 0);
    await input.trigger("keydown", { key: "Insert" });
    await input.trigger("keydown", { key: "A" });
    expect(colOf(el.value, "#")).toBe(before + 1);
    w.unmount();
  });

  /**
   * 全角を全角で上書きすると、SO/SI の位置が変わって桁が足りなくなる。ACS は潰れかけた全角を
   * 消して桁を合わせ、その先の文字は元の桁に残す（実測: `{あいう}    #` の先頭桁へ `１` を入れると
   * `{１} {う}    #`。`あ` と `い` が潰れ、`う` と `#` は動かない）。
   */
  it("全角を全角で上書きすると、潰れた全角は消えて後続は元の桁に残る（ACS 実測）", async () => {
    const { w, input } = mountWith(" あいう    #", 15);
    await input.trigger("focus");
    const el = input.element as HTMLInputElement;
    const before = colOf(el.value, "#");
    const uCol = colOf(el.value, "う");

    el.setSelectionRange(0, 0); // 欄の先頭桁（全角ランの手前の空白）
    await input.trigger("keydown", { key: "１" });

    // {１} {う} …… `あ`・`い` は消え、`う` は元の桁のまま
    expect(el.value).toContain("１");
    expect(el.value).toContain("う");
    expect(el.value).not.toContain("あ");
    expect(el.value).not.toContain("い");
    expect(colOf(el.value, "う")).toBe(uCol); // `う` は元の桁のまま
    expect(colOf(el.value, "#")).toBe(before);
    w.unmount();
  });
});
