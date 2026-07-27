import { describe, it, expect } from "vitest";
import { mount } from "@vue/test-utils";
import ScreenGrid from "../src/components/ScreenGrid.vue";
import type { ScreenSnapshot, Cell, GuiGridLine, GuiWindow } from "@as400web/core";

/**
 * **ホストが引いたグリッド罫線（GRDATR/GRDLIN）と、WDWBORDER のホスト指定枠を描く。**
 *
 * core は WDSF 0x60/0x61 と CREATE WINDOW の Border Presentation を解釈して
 * スナップショットに載せるようになったが、描画側が使わなければ画面には何も出ない
 * （実機環境からの調査報告 dspf-report (2)(3)）。
 */
function cell(char = " "): Cell {
  return {
    char, kind: "sbcs", color: "green", reverse: false, underline: false,
    blink: false, columnSeparator: false, nonDisplay: false
  } as Cell;
}

function snapWithGui(gui: Partial<ScreenSnapshot["gui"]>): ScreenSnapshot {
  const cells: Cell[][] = [];
  for (let r = 0; r < 24; r++) {
    const row: Cell[] = [];
    for (let c = 0; c < 80; c++) row.push(cell());
    cells.push(row);
  }
  return {
    sessionId: "s", rows: 24, cols: 80, cursor: { row: 1, col: 1 },
    keyboardLocked: false, cells, fields: [],
    gui: { selectionFields: [], windows: [], scrollBars: [], gridLines: [], ...gui }
  } as ScreenSnapshot;
}

const grid = (o: Partial<GuiGridLine> = {}): GuiGridLine => ({
  id: 1, minorType: 0x04, row: 3, col: 5, width: 20, height: 6,
  lineStyle: 0x00, color: 0x20, lineRepeat: 0, lineInterval: 0, ...o
});

describe("グリッド罫線の描画", () => {
  it("箱は四辺の線になる", () => {
    const w = mount(ScreenGrid, {
      props: { snapshot: snapWithGui({ gridLines: [grid()] }), edits: new Map(), focused: true }
    });
    const lines = w.findAll(".grid-line");
    expect(lines).toHaveLength(4);
    expect(lines.filter((l) => l.classes().includes("grid-h"))).toHaveLength(2);
    expect(lines.filter((l) => l.classes().includes("grid-v"))).toHaveLength(2);
  });

  it("上辺だけの指定（0x00）は 1 本", () => {
    const w = mount(ScreenGrid, {
      props: { snapshot: snapWithGui({ gridLines: [grid({ minorType: 0x00 })] }), edits: new Map(), focused: true }
    });
    const lines = w.findAll(".grid-line");
    expect(lines).toHaveLength(1);
    expect(lines[0]!.classes()).toContain("grid-h");
  });

  it("縦横罫線付きの箱（0x07）は内部の線も引く", () => {
    const w = mount(ScreenGrid, {
      props: {
        snapshot: snapWithGui({ gridLines: [grid({ minorType: 0x07, lineRepeat: 2, lineInterval: 2 })] }),
        edits: new Map(), focused: true
      }
    });
    // 四辺 4 本 ＋ 内部（横 2・縦 2）＝ 8 本
    expect(w.findAll(".grid-line")).toHaveLength(8);
  });

  it("線種が CSS クラスに反映される", () => {
    const w = mount(ScreenGrid, {
      props: { snapshot: snapWithGui({ gridLines: [grid({ minorType: 0x00, lineStyle: 0x08 })] }), edits: new Map(), focused: true }
    });
    expect(w.find(".grid-line").classes()).toContain("gl-dashed");
  });

  it("色は属性バイトから決まる", () => {
    const w = mount(ScreenGrid, {
      props: { snapshot: snapWithGui({ gridLines: [grid({ minorType: 0x00, color: 0x28 })] }), edits: new Map(), focused: true }
    });
    expect(w.find(".grid-line").classes()).toContain("c-red");
  });

  it("グリッド線が無ければ何も描かない", () => {
    const w = mount(ScreenGrid, { props: { snapshot: snapWithGui({}), edits: new Map(), focused: true } });
    expect(w.findAll(".grid-line")).toHaveLength(0);
  });
});

const win = (border?: GuiWindow["border"]): GuiWindow => ({
  id: 1, row: 5, col: 10, width: 12, height: 4, restrictCursor: false, pulldown: false,
  ...(border ? { border } : {})
});

describe("WDWBORDER（ホスト指定の窓枠）", () => {
  const border = {
    cba: 0x22,
    chars: { ulbc: ".", tbc: "-", urbc: ".", lbc: "|", rbc: "|", llbc: "'", bbc: "-", lrbc: "'" }
  };

  it("ホスト指定の罫線文字で枠を描く", () => {
    const w = mount(ScreenGrid, {
      props: { snapshot: snapWithGui({ windows: [win(border)] }), edits: new Map(), focused: true }
    });
    const rows = w.findAll(".gui-window-border");
    expect(rows).toHaveLength(4); // height 4
    expect(rows[0]!.text()).toBe(".----------.");   // 上辺（幅 12 = 隅 2 ＋ 内側 10）
    expect(rows[1]!.text()).toBe("|          |");   // 側面
    expect(rows[3]!.text()).toBe("'----------'");   // 下辺
  });

  it("枠の色は cba（カラー用属性バイト）から決まる", () => {
    // 0x22 は decodeAttribute で白。0x28 なら赤——色が属性から来ていることを 2 値で確かめる
    const white = mount(ScreenGrid, {
      props: { snapshot: snapWithGui({ windows: [win(border)] }), edits: new Map(), focused: true }
    });
    expect(white.find(".gui-window-border").classes()).toContain("c-white");
    const red = mount(ScreenGrid, {
      props: { snapshot: snapWithGui({ windows: [win({ ...border, cba: 0x28 })] }), edits: new Map(), focused: true }
    });
    expect(red.find(".gui-window-border").classes()).toContain("c-red");
  });

  /**
   * **色だけの指定（実機で実際に来る形）でも枠を描く。**
   * 実機で `WDWBORDER((*COLOR PNK))` を出すと、ホストは罫線文字を載せず
   * 色だけの 5 バイト構造を送ってくる。文字が無いから描かない、では
   * 「ホストが枠を指定したのに枠が出ない」ことになる。
   */
  it("色だけの指定なら既定の罫線文字をホストの色で描く", () => {
    const w = mount(ScreenGrid, {
      props: { snapshot: snapWithGui({ windows: [win({ cba: 0x28 })] }), edits: new Map(), focused: true }
    });
    const rows = w.findAll(".gui-window-border");
    expect(rows).toHaveLength(4);
    expect(rows[0]!.text()).toBe("............"); // 既定の字形
    expect(rows[0]!.classes()).toContain("c-red"); // 色はホスト指定
  });

  it("ホスト指定が無い窓には描かない（従来どおりクライアント設定の枠）", () => {
    const w = mount(ScreenGrid, {
      props: { snapshot: snapWithGui({ windows: [win()] }), edits: new Map(), focused: true }
    });
    expect(w.findAll(".gui-window-border")).toHaveLength(0);
  });
});
