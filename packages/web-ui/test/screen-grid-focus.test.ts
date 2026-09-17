import { describe, it, expect } from "vitest";
import { mount } from "@vue/test-utils";
import { nextTick } from "vue";
import ScreenGrid from "../src/components/ScreenGrid.vue";
import type { ScreenSnapshot, Cell, Field } from "@ts5250/tn5250";

/**
 * **入力欄にフォーカスがあるとき、カーソルは native キャレットの桁に描く。**
 *
 * 画面遷移直後、ホストが報告するカーソルは (1,1) のまま入力欄へ初期フォーカスが入ることがある
 * （STRPDM のようにコマンド入力欄へ飛ぶ画面）。カーソル位置だけで描くと左上にカーソルが残る。
 * 以前は「入力欄の中は native キャレット、外は重ね要素」で二重表示を避けていたが、
 * ACS の表示設定（形状・明滅）を入力欄の中にも効かせるため、**重ね要素 1 本で描き、
 * 位置だけ native キャレットから取る**形にした（native キャレットは透明）。
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

describe("入力欄にフォーカスがあるときのカーソル位置", () => {
  const cursorStyle = (w: ReturnType<typeof mount>) => w.find(".cursor").attributes("style") ?? "";

  it("カーソルが非入力セルでも、入力欄にフォーカスがあれば入力欄のキャレットの桁に描く", async () => {
    const w = mount(ScreenGrid, {
      props: { snapshot: snap(FIELDS), edits: new Map(), focused: false },
      attachTo: document.body
    });
    // 初期状態: カーソル (1,1)
    expect(cursorStyle(w)).toContain("left: 0ch");

    // 入力欄へフォーカスが入った（画面遷移直後の初期フォーカス相当）→ 欄の先頭 (20,8)
    (w.find("input.grid-input").element as HTMLInputElement).focus();
    await nextTick();
    expect(w.findAll(".cursor")).toHaveLength(1); // 左上に残らない（二重に出さない）
    expect(cursorStyle(w)).toContain("left: 7ch");
    expect(cursorStyle(w)).toContain("top: 23.75em");
    w.unmount();
  });

  it("キャレットが動けば（selectionchange）カーソルも動く", async () => {
    const w = mount(ScreenGrid, {
      props: { snapshot: snap(FIELDS), edits: new Map(), focused: false },
      attachTo: document.body
    });
    const el = w.find("input.grid-input").element as HTMLInputElement;
    el.focus();
    await nextTick();
    // 通知（emit cursor）を伴わないキャレット移動（前の欄の末尾へ戻る経路など）
    el.setSelectionRange(5, 5);
    document.dispatchEvent(new Event("selectionchange"));
    await nextTick();
    expect(cursorStyle(w)).toContain("left: 12ch"); // 8 桁目 + 5
    w.unmount();
  });

  it("入力欄からフォーカスが外れれば有効カーソルの桁に戻る", async () => {
    const w = mount(ScreenGrid, {
      props: { snapshot: snap(FIELDS), edits: new Map(), focused: false },
      attachTo: document.body
    });
    const input = w.find("input.grid-input");
    (input.element as HTMLInputElement).focus();
    await nextTick();
    expect(cursorStyle(w)).toContain("left: 7ch");

    (input.element as HTMLInputElement).blur();
    await nextTick();
    expect(cursorStyle(w)).toContain("left: 0ch");
    w.unmount();
  });

  it("入力欄が無い画面でもカーソルが出る（従来どおり）", () => {
    const w = mount(ScreenGrid, { props: { snapshot: snap([]), edits: new Map(), focused: true } });
    expect(w.find(".cursor").exists()).toBe(true);
    w.unmount();
  });
});

describe("入力欄の色は属性に従う", () => {
  /**
   * 以前は .grid-input が color: var(--t-white) を固定しており、
   * scoped スタイルのぶん詳細度が高いためグローバルの .c-* を常に上書きしていた。
   * ホストが緑で送った入力欄が白く描かれる（PDM のメンバー一覧など）。
   */
  function withField(color: Cell["color"]): ScreenSnapshot {
    const sn = snap([{ ...FIELDS[0]! }]);
    // 入力欄がある行（FIELDS[0].row = 20）を丸ごと塗る
    const ri = FIELDS[0]!.row - 1;
    sn.cells[ri] = sn.cells[ri]!.map((c) => ({ ...cell(c.char), color }));
    return sn;
  }

  it("緑の入力欄には c-green が付く（白で固定しない）", () => {
    const w = mount(ScreenGrid, { props: { snapshot: withField("green"), edits: new Map(), focused: true } });
    const input = w.find("input.grid-input");
    expect(input.classes()).toContain("c-green");
    expect(input.classes()).not.toContain("c-white");
    w.unmount();
  });

  it("白の入力欄には c-white が付く", () => {
    const w = mount(ScreenGrid, { props: { snapshot: withField("white"), edits: new Map(), focused: true } });
    expect(w.find("input.grid-input").classes()).toContain("c-white");
    w.unmount();
  });
});
