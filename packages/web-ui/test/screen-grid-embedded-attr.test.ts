import { describe, it, expect } from "vitest";
import { reactive, nextTick } from "vue";
import { mount } from "@vue/test-utils";
import ScreenGrid from "../src/components/ScreenGrid.vue";
import type { ScreenSnapshot, Cell, Field } from "@as400web/core";

/**
 * **入力欄の埋め込み属性（欄途中の色替え）を色付きオーバーレイで表現する。**
 *
 * SEU のソース行のように、入力欄のデータ内に画面属性バイトが埋め込まれて色が付くことがある。
 * `<input>` は 1 要素 1 色しか出せないので、色替えのある欄には色付き span を重ねる。
 * 色替えの無い通常欄はオーバーレイを付けない（従来描画＝影響ゼロ）ことも固定する。
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

/** row 5(0基点) col 9〜 に、緑"ABC" + 赤属性(空白) + 赤"DEF" + 赤空白 を置く */
function snapWithEmbeddedAttr(): ScreenSnapshot {
  const cells: Cell[][] = [];
  for (let r = 0; r < 24; r++) {
    const row: Cell[] = [];
    for (let c = 0; c < 80; c++) row.push(cell(" "));
    cells.push(row);
  }
  const row = cells[5]!;
  row[9] = cell("A", { color: "green" });
  row[10] = cell("B", { color: "green" });
  row[11] = cell("C", { color: "green" });
  row[12] = cell(" ", { kind: "attr", color: "red" }); // 埋め込み属性（赤・空白）
  row[13] = cell("D", { color: "red" });
  row[14] = cell("E", { color: "red" });
  row[15] = cell("F", { color: "red" });
  for (let c = 16; c <= 20; c++) row[c] = cell(" ", { color: "red" });
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

const FIELD: Field = {
  index: 1,
  row: 6,
  col: 10,
  length: 12,
  protected: false,
  hidden: false,
  numeric: false,
  mdt: false,
  value: "ABC DEF" // 属性位置は空白（core fieldValue と同じ・桁は保つ）
};

describe("入力欄の埋め込み属性（色替え）", () => {
  it("色替えのある欄はオーバーレイを重ね、input のテキストは透明にする", () => {
    const snap = snapWithEmbeddedAttr();
    snap.fields = [FIELD];
    const w = mount(ScreenGrid, { props: { snapshot: snap, edits: new Map(), focused: true } });

    // input は has-overlay（テキスト透明）、包む input-cell は overlaid
    const input = w.find("input.grid-input");
    expect(input.classes()).toContain("has-overlay");
    expect(w.find(".input-cell.overlaid").exists()).toBe(true);

    // オーバーレイに緑"ABC" と 赤" DEF…" の 2 バンドが出る
    const overlay = w.find(".input-overlay");
    expect(overlay.exists()).toBe(true);
    const spans = overlay.findAll("span");
    expect(spans.length).toBe(2);
    // .text() は空白を trim するので textContent で桁を検証する
    const txt = (i: number): string => spans[i]!.element.textContent ?? "";
    expect(spans[0]!.classes()).toContain("c-green");
    expect(txt(0)).toBe("ABC");
    expect(spans[1]!.classes()).toContain("c-red");
    // 属性桁は空白 → " DEF" で始まる（桁ずれしない）
    expect(txt(1).startsWith(" DEF")).toBe(true);

    // オーバーレイ全体を連結すると input の値と一致（桁が保たれている）
    const joined = txt(0) + txt(1);
    const value = (input.element as HTMLInputElement).value;
    expect(joined).toBe(value);
  });

  it("DBCS 欄でも埋め込み属性が桁を保ち（桁ずれしない）色付けされる", () => {
    // セル: A(sbcs緑) SO あ(lead緑) tail SI 属性(赤) B(sbcs赤) …（col10=index9 から）
    const cells: Cell[][] = [];
    for (let r = 0; r < 24; r++) {
      const row: Cell[] = [];
      for (let c = 0; c < 80; c++) row.push(cell(" "));
      cells.push(row);
    }
    const row = cells[5]!;
    row[9] = cell("A", { color: "green" });
    row[10] = cell(" ", { kind: "so", color: "green" });
    row[11] = cell("あ", { kind: "dbcs-lead", color: "green" });
    row[12] = cell("", { kind: "dbcs-tail", color: "green" });
    row[13] = cell(" ", { kind: "si", color: "green" });
    row[14] = cell(" ", { kind: "attr", color: "red" }); // 埋め込み属性（赤）
    row[15] = cell("B", { color: "red" });
    for (let c = 16; c <= 16; c++) row[c] = cell(" ", { color: "red" });
    const snap: ScreenSnapshot = {
      sessionId: "s",
      rows: 24,
      cols: 80,
      cursor: { row: 1, col: 1 },
      keyboardLocked: false,
      cells,
      fields: [
        {
          index: 1,
          row: 6,
          col: 10,
          length: 8,
          protected: false,
          hidden: false,
          numeric: false,
          dbcsType: "open",
          mdt: false,
          value: ""
        }
      ]
    };
    const w = mount(ScreenGrid, { props: { snapshot: snap, edits: new Map(), focused: false } });

    // 色替えがあるのでオーバーレイが付く
    const overlay = w.find(".input-overlay");
    expect(overlay.exists()).toBe(true);
    const spans = overlay.findAll("span");
    expect(spans.some((s) => s.classes().includes("c-green"))).toBe(true);
    expect(spans.some((s) => s.classes().includes("c-red"))).toBe(true);

    // **桁ずれしない**の要: オーバーレイ連結 = input の値（属性桁が空白として保たれ、B が正しい桁に来る）
    const joined = spans.map((s) => s.element.textContent ?? "").join("");
    const value = (w.find("input.grid-input").element as HTMLInputElement).value;
    expect(joined).toBe(value);
    // 属性桁が落ちていない証拠: B の前に属性ぶんの空白がある（"…B" が直前の全角に密着しない）
    expect(value).toContain(" B");
  });

  it("編集して blur すると、編集値を色付きオーバーレイで表示する（元の値に戻らない）", async () => {
    const snap = snapWithEmbeddedAttr();
    snap.fields = [FIELD];
    const edits = reactive(new Map<number, string>());
    const w = mount(ScreenGrid, {
      props: { snapshot: snap, edits, focused: true },
      attachTo: document.body
    });
    const input = w.find("input.grid-input");
    await input.trigger("focus");

    // 未編集の色付きオーバーレイが出ている
    expect(w.find(".input-overlay").exists()).toBe(true);

    // 編集（C→Z、桁は保つ）を入れて blur → blur で再描画トリガー（renderTick）
    edits.set(1, "ABZ DEF");
    await input.trigger("blur");
    await nextTick();

    // **オーバーレイは残り、編集値を反映**（"ABZ" が出て元の "ABC" ではない＝色ごと消えない）
    const overlay = w.find(".input-overlay");
    expect(overlay.exists()).toBe(true);
    const text = overlay.findAll("span").map((s) => s.element.textContent ?? "").join("");
    expect(text).toContain("ABZ");
    expect(text).not.toContain("ABC");
    // 色バンドも維持（緑と赤）
    const spans = overlay.findAll("span");
    expect(spans.some((s) => s.classes().includes("c-green"))).toBe(true);
    expect(spans.some((s) => s.classes().includes("c-red"))).toBe(true);
    w.unmount();
  });

  it("色替えの無い通常欄はオーバーレイを付けない（従来描画）", () => {
    const cells: Cell[][] = [];
    for (let r = 0; r < 24; r++) {
      const rrow: Cell[] = [];
      for (let c = 0; c < 80; c++) rrow.push(cell(" ", { color: "green" }));
      cells.push(rrow);
    }
    const snap: ScreenSnapshot = {
      sessionId: "s",
      rows: 24,
      cols: 80,
      cursor: { row: 1, col: 1 },
      keyboardLocked: false,
      cells,
      fields: [{ ...FIELD, value: "PLAIN" }]
    };
    const w = mount(ScreenGrid, { props: { snapshot: snap, edits: new Map(), focused: true } });
    expect(w.find(".input-overlay").exists()).toBe(false);
    expect(w.find("input.grid-input").classes()).not.toContain("has-overlay");
  });
});
