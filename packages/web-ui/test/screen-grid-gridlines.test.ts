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
  lineStyle: 0x00, color: 0x07, hRule: 0, vRule: 0, ...o
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

  /**
   * **内部罫線は「本数」ではなく「間隔」**（DDS `(*TYPE HRZVRT h v)` の h/v）。
   * 実機の DSPF `(*POS (15 5 6 40)) (*TYPE HRZVRT 2 8)` は
   * 6 行 × 40 桁の箱に「2 行ごと・8 桁ごと」で、ACS では横 2 本・縦 4 本になる。
   * 本数と読むと横 0 本・縦 2 本になり、ACS の表示と食い違う。
   */
  /**
   * **箱は閉じる。** 罫線はセルの中ではなく境界に引くので、
   * 下辺は「最終行の下端」、右辺は「最終桁の右端」に来る。
   * 行番号・桁番号のまま置くと下辺と右辺だけ 1 つ内側に寄り、
   * 辺の長さは正しいのに箱が閉じない（ACS との比較で見つけた不具合）。
   */
  it("箱の下辺・右辺は最終行の下端・最終桁の右端に来る", () => {
    const w = mount(ScreenGrid, {
      props: {
        // 行 5 桁 5 の 40 桁 × 8 行 → 下辺は行 12 の下端＝12em 相当、右辺は桁 44 の右端＝44ch
        snapshot: snapWithGui({
          gridLines: [grid({ minorType: 0x04, row: 5, col: 5, width: 40, height: 8 })]
        }),
        edits: new Map(), focused: true
      }
    });
    const h = w.findAll(".grid-line.grid-h").map((l) => l.attributes("style"));
    const v = w.findAll(".grid-line.grid-v").map((l) => l.attributes("style"));
    expect(h[0]).toContain("top: 5em;");    // 上辺 = 行 5 の上端 (5-1)*1.25em
    expect(h[1]).toContain("top: 15em;");   // 下辺 = 行 12 の下端 (5-1+8)*1.25em
    expect(v[0]).toContain("left: 4ch;");   // 左辺 = 桁 5 の左端
    expect(v[1]).toContain("left: 44ch;");  // 右辺 = 桁 44 の右端
    // 辺の長さは上下・左右で閉じた矩形になる
    expect(h[0]).toContain("width: 40ch;");
    expect(v[0]).toContain("height: 10em;"); // 8 行 × 1.25em
  });

  it("縦横罫線付きの箱（0x07）は間隔ぶん内部の線を引く", () => {
    const w = mount(ScreenGrid, {
      props: {
        // 実機と同じ: 行 15 桁 5、幅 40 深さ 6、横罫 2 行ごと・縦罫 8 桁ごと
        snapshot: snapWithGui({
          gridLines: [grid({ minorType: 0x07, row: 15, col: 5, width: 40, height: 6, hRule: 2, vRule: 8 })]
        }),
        edits: new Map(), focused: true
      }
    });
    const lines = w.findAll(".grid-line");
    // 四辺 4 本 ＋ 横罫 2 本（行 17・19）＋ 縦罫 4 本（桁 13・21・29・37）＝ 10 本
    expect(lines).toHaveLength(10);
    expect(lines.filter((l) => l.classes().includes("grid-h"))).toHaveLength(4); // 上下 2 ＋ 横罫 2
    expect(lines.filter((l) => l.classes().includes("grid-v"))).toHaveLength(6); // 左右 2 ＋ 縦罫 4
  });

  it("線種が CSS クラスに反映される", () => {
    const w = mount(ScreenGrid, {
      props: { snapshot: snapWithGui({ gridLines: [grid({ minorType: 0x00, lineStyle: 0x08 })] }), edits: new Map(), focused: true }
    });
    expect(w.find(".grid-line").classes()).toContain("gl-dashed");
  });

  /**
   * **グリッド線の色は 5250 の属性バイトではない。**
   * DDS リファレンス（GRDATR の Table 14「Valid color values」）が定める専用コードで、
   * BLU=X'01' GRN=X'02' CYAN=X'03' RED=X'04' … NONE=X'FF'。
   * 属性バイトとして decodeAttribute に渡すと全部緑になってしまう。
   */
  it("色はグリッド専用の色コードから決まる", () => {
    const red = mount(ScreenGrid, {
      props: { snapshot: snapWithGui({ gridLines: [grid({ minorType: 0x00, color: 0x04 })] }), edits: new Map(), focused: true }
    });
    expect(red.find(".grid-line").classes()).toContain("c-red");
    const blue = mount(ScreenGrid, {
      props: { snapshot: snapWithGui({ gridLines: [grid({ minorType: 0x00, color: 0x01 })] }), edits: new Map(), focused: true }
    });
    expect(blue.find(".grid-line").classes()).toContain("c-blue");
  });

  it("X'FF'（表示装置の既定）と未知の値は白に倒す", () => {
    const w = mount(ScreenGrid, {
      props: { snapshot: snapWithGui({ gridLines: [grid({ minorType: 0x00, color: 0xff })] }), edits: new Map(), focused: true }
    });
    expect(w.find(".grid-line").classes()).toContain("c-white");
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
    // **枠は窓の外側**。窓 12x4 なら枠は 16 桁 × 6 行（上下に 1 行・左右に 2 桁）。
    // 窓の本体に重ねると窓の中身を塗り潰してしまう
    expect(rows).toHaveLength(6);
    expect(rows[0]!.text()).toBe(".--------------.");   // 上辺（16 桁 = 隅 2 ＋ 内側 14）
    expect(rows[1]!.text()).toBe("|              |");   // 側面
    expect(rows[5]!.text()).toBe("'--------------'");   // 下辺
    expect(rows[0]!.attributes("style")).toContain("left: 10ch;"); // 桁 11 の左端
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
   * **色だけの指定（実機で実際に来る形）は線の枠として描く。**
   * 実機で `WDWBORDER((*COLOR PNK))` を出すと、ホストは罫線文字を載せず
   * 色だけの 5 バイト構造を送ってくる。文字が無いから描かない、では
   * 「ホストが枠を指定したのに枠が出ない」ことになる。
   * 字形はこちらで決めるしかないが、**ACS は線で枠を引く**ので線に揃える
   * （`.` `:` の記号で描いていた頃は ACS の画面と見た目が食い違っていた）。
   */
  it("色だけの指定ならホストの色の線で枠を描く", () => {
    const w = mount(ScreenGrid, {
      props: { snapshot: snapWithGui({ windows: [win({ cba: 0x28 })] }), edits: new Map(), focused: true }
    });
    const segs = w.findAll(".gui-window-border");
    expect(segs).toHaveLength(4); // 上下左右
    expect(segs.every((s) => s.text() === "")).toBe(true); // 文字ではなく線
    expect(segs[0]!.classes()).toContain("c-red"); // 色はホスト指定
    // **枠は窓の外側**。窓 row 5 col 10 の 12x4 なら枠セルは行 5〜10・桁 11〜26 で、
    // 線はそのセルの中心を通る（上辺 4.5・下辺 9.5・左辺 10.5・右辺 25.5）
    expect(segs[0]!.attributes("style")).toContain("top: 5.625em;");   // 4.5 * 1.25em
    expect(segs[1]!.attributes("style")).toContain("top: 11.875em;");  // 9.5 * 1.25em
    expect(segs[2]!.attributes("style")).toContain("left: 10.5ch;");
    expect(segs[3]!.attributes("style")).toContain("left: 25.5ch;");
    expect(segs[0]!.attributes("style")).toContain("width: 15ch;");    // 幅 12 ＋ 左右の枠 3
    expect(segs[2]!.attributes("style")).toContain("height: 6.25em;"); // 高さ 4 ＋ 上下の枠 1
  });

  it("ホスト指定が無い窓には描かない（従来どおりクライアント設定の枠）", () => {
    const w = mount(ScreenGrid, {
      props: { snapshot: snapWithGui({ windows: [win()] }), edits: new Map(), focused: true }
    });
    expect(w.findAll(".gui-window-border")).toHaveLength(0);
  });
});

/**
 * **ホスト指定の枠がある窓に、クライアント設定の枠を重ねない。**
 * ACS はホストが `WDWBORDER` で指定した枠だけを出す。上から自前の装飾枠を描くと
 * 二重になり、実機と食い違う（利用者のスクリーンショット比較で判明）。
 */
describe("ホスト枠とクライアント枠の二重描画", () => {
  const hostBorder = { cba: 0x28 };

  it("ホスト枠のある窓では装飾枠（win-deco）を描かない", () => {
    const w = mount(ScreenGrid, {
      props: {
        snapshot: snapWithGui({ windows: [win(hostBorder)] }),
        edits: new Map(), focused: true, windowFrame: "outline"
      }
    });
    expect(w.findAll(".gui-window-border").length).toBeGreaterThan(0); // ホスト枠は出る
    expect(w.find(".win-deco").exists()).toBe(false);                  // 装飾枠は出ない
  });

  it("ホスト枠が無ければ従来どおり装飾枠を使う", () => {
    const cells: Cell[][] = [];
    for (let r = 0; r < 24; r++) {
      const row: Cell[] = [];
      for (let c = 0; c < 80; c++) row.push(cell());
      cells.push(row);
    }
    const snap = {
      sessionId: "s", rows: 24, cols: 80, cursor: { row: 1, col: 1 },
      keyboardLocked: false, cells, fields: [],
      gui: { selectionFields: [], windows: [win()], scrollBars: [], gridLines: [] }
    } as ScreenSnapshot;
    const w = mount(ScreenGrid, {
      props: { snapshot: snap, edits: new Map(), focused: true, windowFrame: "outline" }
    });
    expect(w.findAll(".gui-window-border")).toHaveLength(0);
  });
});
