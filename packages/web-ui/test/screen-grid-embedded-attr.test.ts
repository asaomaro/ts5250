import { describe, it, expect } from "vitest";
import { reactive, nextTick } from "vue";
import { mount } from "@vue/test-utils";
import ScreenGrid from "../src/components/ScreenGrid.vue";
import type { ScreenSnapshot, Cell, Field } from "@as400web/core";

/**
 * **入力欄の埋め込み属性（欄途中の色替え）を色付きオーバーレイで表現する。**
 *
 * SEU のソース行のように、入力欄のデータ内に画面属性バイトが埋め込まれて色が付くことがある。
 * core は SBCS 欄の埋め込み属性を値の中で**センチネル文字**として返す（U+E020–U+E03F）。
 * `<input>` は 1 要素 1 色しか出せないので、色替えのある欄には色付き span を重ねる。
 * オーバーレイの色境界は**値のセンチネル**で決まるので、編集で属性が動けば色も動く。
 */
/** 属性バイト → センチネル文字（core screen/attr-sentinel と同じ規約） */
const SENT = (b: number): string => String.fromCharCode(0xe000 + b);

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

/** row 5(0基点) col 9〜 に、緑"ABC" + 赤属性 + 赤"DEF" を置く（オーバーレイ presence の判定用セル） */
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
  row[12] = cell(" ", { kind: "attr", color: "red" }); // 埋め込み属性（赤）
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

// 値の属性位置はセンチネル（core fieldValue の出力形）。"ABC" + 赤属性(0x28) + "DEF"
const FIELD: Field = {
  index: 1,
  row: 6,
  col: 10,
  length: 12,
  protected: false,
  hidden: false,
  numeric: false,
  mdt: false,
  value: "ABC" + SENT(0x28) + "DEF"
};

describe("入力欄の埋め込み属性（色替え）", () => {
  it("色替えのある欄はオーバーレイを重ね、input のテキストは透明・センチネルは空白で表示", () => {
    const snap = snapWithEmbeddedAttr();
    snap.fields = [FIELD];
    const w = mount(ScreenGrid, { props: { snapshot: snap, edits: new Map(), focused: true } });

    const input = w.find("input.grid-input");
    expect(input.classes()).toContain("has-overlay");
    expect(w.find(".input-cell.overlaid").exists()).toBe(true);

    // input の表示値はセンチネル→空白（トーフを出さない）
    const value = (input.element as HTMLInputElement).value;
    expect(value.startsWith("ABC DEF")).toBe(true);
    expect(value).not.toContain(SENT(0x28));

    // オーバーレイに 緑"ABC" と 赤" DEF…" の 2 バンドが出る
    const overlay = w.find(".input-overlay");
    expect(overlay.exists()).toBe(true);
    const spans = overlay.findAll("span");
    const txt = (i: number): string => spans[i]!.element.textContent ?? "";
    expect(spans.length).toBe(2);
    expect(spans[0]!.classes()).toContain("c-green");
    expect(txt(0)).toBe("ABC");
    expect(spans[1]!.classes()).toContain("c-red");
    expect(txt(1).startsWith(" DEF")).toBe(true); // 属性桁は空白（桁ずれしない）

    // オーバーレイ連結 = input の表示値（桁が保たれている）
    expect(txt(0) + txt(1)).toBe(value);
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
    expect(w.find(".input-overlay").exists()).toBe(true);

    // C→Z に編集（センチネルは保つ＝属性も残る）して blur → renderTick で再描画
    edits.set(1, "ABZ" + SENT(0x28) + "DEF");
    await input.trigger("blur");
    await nextTick();

    const overlay = w.find(".input-overlay");
    expect(overlay.exists()).toBe(true);
    const text = overlay.findAll("span").map((s) => s.element.textContent ?? "").join("");
    expect(text).toContain("ABZ"); // 編集値
    expect(text).not.toContain("ABC"); // 元の値に戻らない
    const spans = overlay.findAll("span");
    expect(spans.some((s) => s.classes().includes("c-green"))).toBe(true);
    expect(spans.some((s) => s.classes().includes("c-red"))).toBe(true);
    w.unmount();
  });

  it("属性より前を削って属性が動くと、色境界も一緒に動く", async () => {
    const snap = snapWithEmbeddedAttr();
    snap.fields = [FIELD];
    const edits = reactive(new Map<number, string>());
    const w = mount(ScreenGrid, {
      props: { snapshot: snap, edits, focused: true },
      attachTo: document.body
    });
    const input = w.find("input.grid-input");
    await input.trigger("focus");

    // 先頭 A を削除 → "BC" + 属性 + "DEF"（属性が 1 桁左へ）
    edits.set(1, "BC" + SENT(0x28) + "DEF");
    await input.trigger("blur");
    await nextTick();

    const spans = w.find(".input-overlay").findAll("span");
    const green = spans.find((s) => s.classes().includes("c-green"))!;
    // 緑は "BC"（2 桁）に縮む＝色境界が属性と一緒に左へ動いた
    expect(green.element.textContent).toBe("BC");
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
