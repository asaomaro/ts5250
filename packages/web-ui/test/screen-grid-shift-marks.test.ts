import { describe, it, expect } from "vitest";
import { mount } from "@vue/test-utils";
import ScreenGrid from "../src/components/ScreenGrid.vue";
import type { ScreenSnapshot, Cell, Field } from "@ts5250/tn5250";

/**
 * **FCW で DBCS 宣言されていない欄でも SO/SI マークを出す。**
 *
 * ホストは出力専用の欄に FCW を付けないことがある（PDM のテキスト列など）。この欄は
 * `Field.dbcsType` が undefined なので DBCS 用の描画経路に入らず、core の `fieldValue` が
 * SO/SI を空白に潰した値をそのまま表示していた。結果、SO/SI マーク表示（ACS の Ctrl+F 相当）を
 * ON にしても `{ }` が出ず、空白のままだった——同じ画面の定数（見出し等）には出ているのに。
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

/** row 6 / col 10 から 10 桁の欄に「SO 取引 SI」を置く（FCW 無し＝dbcsType undefined） */
function snapshotWithShiftCells(): ScreenSnapshot {
  const cells: Cell[][] = [];
  for (let r = 0; r < 24; r++) {
    const row: Cell[] = [];
    for (let c = 0; c < 80; c++) row.push(cell(" "));
    cells.push(row);
  }
  const row = cells[5]!;
  row[9] = cell(" ", { kind: "so" });
  row[10] = cell("取", { kind: "dbcs-lead" });
  row[11] = cell("", { kind: "dbcs-tail" });
  row[12] = cell("引", { kind: "dbcs-lead" });
  row[13] = cell("", { kind: "dbcs-tail" });
  row[14] = cell(" ", { kind: "si" });
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

/** core の fieldValue は SO/SI を空白として返す（欄は DBCS 宣言されていない） */
const FIELD: Field = {
  index: 1,
  row: 6,
  col: 10,
  length: 10,
  protected: true,
  hidden: false,
  numeric: false,
  mdt: false,
  value: " 取引 "
};

function inputValueOf(showShiftMarks: boolean): string {
  const snapshot = snapshotWithShiftCells();
  snapshot.fields = [FIELD];
  const w = mount(ScreenGrid, {
    props: { snapshot, edits: new Map(), focused: true, showShiftMarks }
  });
  return (w.find("input.grid-input").element as HTMLInputElement).value;
}

describe("SO/SI マーク表示（DBCS 宣言の無い欄）", () => {
  it("マーク表示 ON なら欄の中でも { } が出る", () => {
    expect(inputValueOf(true).startsWith("{取引}")).toBe(true);
  });

  it("マーク表示 OFF なら従来どおり空白（桁は保たれる）", () => {
    expect(inputValueOf(false).startsWith(" 取引 ")).toBe(true);
  });

  it("欄長ぶんの桁が保たれる（全角は 2 桁ぶんを 1 文字で占める）", () => {
    // SO(1) + 全角 2 文字(1 文字ずつ・4 桁) + SI(1) + 残り 4 桁の空白 = 文字数 10 - tail 2 = 8
    expect(inputValueOf(true)).toHaveLength(8);
  });
});


/**
 * **SO/SI マークは淡色で描く**（`a-shift`）。
 *
 * 表示は ACS と同じ `{ }` だが、ホストのデータに本物の `{ }` が混ざると**どちらが制御桁か
 * 見分けが付かない**（利用者の指摘。SEU でソースを見ると実際に混ざる）。色だけを分けるので、
 * **桁・文字・コピー・送信値は 1 つも変えない**——ここが崩れると桁ずれになる。
 */

/** 24x80 の空画面 */
function blankCells(): Cell[][] {
  const cells: Cell[][] = [];
  for (let r = 0; r < 24; r++) {
    const row: Cell[] = [];
    for (let c = 0; c < 80; c++) row.push(cell(" "));
    cells.push(row);
  }
  return cells;
}

function snapOf(cells: Cell[][], fields: Field[] = []): ScreenSnapshot {
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

/** 行 1 に「SO 取 SI」＋本物の `{}` を置く（欄の外＝素のテキストラン） */
function snapshotWithTextMarks(): ScreenSnapshot {
  const cells = blankCells();
  const row = cells[0]!;
  row[0] = cell(" ", { kind: "so" });
  row[1] = cell("取", { kind: "dbcs-lead" });
  row[2] = cell("", { kind: "dbcs-tail" });
  row[3] = cell(" ", { kind: "si" });
  row[4] = cell("{");
  row[5] = cell("}");
  return snapOf(cells);
}

describe("SO/SI マークの淡色表示", () => {
  it("SO/SI だけが淡色になり、本物の { } はそのまま", () => {
    const w = mount(ScreenGrid, {
      props: { snapshot: snapshotWithTextMarks(), edits: new Map(), focused: false, showShiftMarks: true }
    });
    // 淡色なのは SO/SI の 2 桁だけ（本物の { } は素のテキストのまま）
    expect(w.findAll("span.a-shift").map((s) => s.text())).toEqual(["{", "}"]);
    // 文字そのものは変わらない（マーク 2 つ＋本物 2 つ＝ブレースは 4 つ）
    const line = w.findAll(".grid-row")[0]!.element.textContent ?? "";
    expect(line.startsWith("{取}{}")).toBe(true);
    w.unmount();
  });

  it("マーク表示 OFF なら淡色の桁は無い（従来どおり空白）", () => {
    const w = mount(ScreenGrid, {
      props: { snapshot: snapshotWithTextMarks(), edits: new Map(), focused: false, showShiftMarks: false }
    });
    expect(w.findAll("span.a-shift")).toHaveLength(0);
    const line = w.findAll(".grid-row")[0]!.element.textContent ?? "";
    expect(line.startsWith(" 取 {}")).toBe(true);
    w.unmount();
  });

  it("**印を素で出さない**（列ビューに入れる SO/SI の印は画面に漏れない）", () => {
    const w = mount(ScreenGrid, {
      props: { snapshot: snapshotWithTextMarks(), edits: new Map(), focused: false, showShiftMarks: true }
    });
    const text = w.element.textContent ?? "";
    expect(text.includes("\u000e") || text.includes("\u000f")).toBe(false);
    w.unmount();
  });

  it("凡例ボタンは割れず、中の SO/SI だけ淡色になる", () => {
    const cells = blankCells();
    const row = cells[0]!;
    const head = [..."F3="];
    head.forEach((ch, i) => (row[i] = cell(ch)));
    row[3] = cell(" ", { kind: "so" });
    row[4] = cell("終", { kind: "dbcs-lead" });
    row[5] = cell("", { kind: "dbcs-tail" });
    row[6] = cell("了", { kind: "dbcs-lead" });
    row[7] = cell("", { kind: "dbcs-tail" });
    row[8] = cell(" ", { kind: "si" });
    const w = mount(ScreenGrid, {
      props: { snapshot: snapOf(cells), edits: new Map(), focused: false, showShiftMarks: true, buttons: "box" }
    });
    const btns = w.findAll("button.fkey-btn");
    expect(btns.map((b) => b.text())).toEqual(["F3={終了}"]);
    expect(btns[0]!.findAll("span.a-shift").map((s) => s.text())).toEqual(["{", "}"]);
    w.unmount();
  });
});

describe("SO/SI マークの淡色表示（入力欄）", () => {
  /** `<input>` は 1 要素 1 色なので、桁ごとの色はオーバーレイで描く */
  function mountField(showShiftMarks: boolean) {
    const snapshot = snapshotWithShiftCells();
    snapshot.fields = [FIELD];
    return mount(ScreenGrid, {
      props: { snapshot, edits: new Map(), focused: true, showShiftMarks }
    });
  }

  it("欄の中の SO/SI も淡色になる（入力欄の値は従来どおり）", () => {
    const w = mountField(true);
    const overlay = w.find(".input-overlay");
    expect(overlay.exists()).toBe(true);
    expect(overlay.findAll("span.a-shift").map((s) => s.text())).toEqual(["{", "}"]);
    // オーバーレイの文字列は入力欄の値と 1 文字も違わない（違うと桁がずれて見える）
    const value = (w.find("input.grid-input").element as HTMLInputElement).value;
    expect(overlay.element.textContent).toBe(value);
    expect(value.startsWith("{取引}")).toBe(true);
    w.unmount();
  });

  it("マーク表示 OFF ならオーバーレイを重ねない（従来の描画のまま）", () => {
    const w = mountField(false);
    expect(w.find(".input-overlay").exists()).toBe(false);
    expect(w.findAll("span.a-shift")).toHaveLength(0);
    w.unmount();
  });
});

/**
 * **「濃目」（`shiftMarkTone: "strong"`）は薄目より濃く、ふつうの文字より薄い。**
 *
 * 淡色は本物の `{ }` と見分けるための工夫だが、明るい部屋や低コントラストの配色では
 * **マークそのものが読み取りにくい**。そこで濃さを選べるようにした（画面設定 SO/SI 表示＝
 * 非表示 / 薄目 / 濃目）。**桁の色そのままにはしない**——同じ色にすると本物の `{ }` と
 * 区別が付かなくなり、色を分けた意味が消えるため。差は色だけで、桁・文字・値は薄目と同じ。
 */
describe("SO/SI マークの濃目表示", () => {
  function mountStrong(snapshot: ScreenSnapshot, focused = false) {
    return mount(ScreenGrid, {
      props: { snapshot, edits: new Map(), focused, showShiftMarks: true, shiftMarkTone: "strong" }
    });
  }

  it("淡色クラスに濃さの修飾子が付く（薄目と同じ桁・同じ文字）", () => {
    const w = mountStrong(snapshotWithTextMarks());
    const marks = w.findAll("span.a-shift");
    expect(marks.map((m) => m.text())).toEqual(["{", "}"]);
    // 修飾子が付くのはマークだけ。`a-shift` 自体は付いたまま（反転桁の規則を共有する）
    expect(marks.every((m) => m.classes().includes("a-shift-strong"))).toBe(true);
    const line = w.findAll(".grid-row")[0]!.element.textContent ?? "";
    expect(line.startsWith("{取}{}")).toBe(true); // 薄目と同じ絵（色だけが違う）
    w.unmount();
  });

  it("薄目には修飾子を付けない（既定は薄目）", () => {
    const w = mount(ScreenGrid, {
      props: { snapshot: snapshotWithTextMarks(), edits: new Map(), focused: false, showShiftMarks: true }
    });
    expect(w.findAll("span.a-shift-strong")).toHaveLength(0);
    w.unmount();
  });

  it("**印を素で出さない**（濃目でも列ビューの印は画面に漏れない）", () => {
    const w = mountStrong(snapshotWithTextMarks());
    const text = w.element.textContent ?? "";
    expect(text.includes("\u000e") || text.includes("\u000f")).toBe(false);
    w.unmount();
  });

  /**
   * **切り替えたら画面の中も追従する。** 行は `v-memo` でキャッシュしており、濃さは
   * 文字も桁も変えず class だけが変わる——依存に入れ忘れると `segs` が同じまま行が
   * 再描画されず、**操作員メッセージ行だけ切り替わって画面の中は取り残される**
   * （利用者の指摘）。設定を変えたあとの状態を見るため `setProps` で確かめる。
   */
  it("薄目 ⇄ 濃目 を切り替えると画面の中の桁も追従する", async () => {
    const w = mount(ScreenGrid, {
      props: { snapshot: snapshotWithTextMarks(), edits: new Map(), focused: false, showShiftMarks: true }
    });
    expect(w.findAll("span.a-shift-strong")).toHaveLength(0);
    await w.setProps({ shiftMarkTone: "strong" });
    expect(w.findAll("span.a-shift-strong").map((m) => m.text())).toEqual(["{", "}"]);
    await w.setProps({ shiftMarkTone: "dim" });
    expect(w.findAll("span.a-shift-strong")).toHaveLength(0);
    expect(w.findAll("span.a-shift").map((m) => m.text())).toEqual(["{", "}"]);
    w.unmount();
  });

  it("入力欄のオーバーレイにも修飾子が付く（値は薄目と同じ）", () => {
    const snapshot = snapshotWithShiftCells();
    snapshot.fields = [FIELD];
    const w = mountStrong(snapshot, true);
    const overlay = w.find(".input-overlay");
    expect(overlay.exists()).toBe(true);
    expect(overlay.findAll("span.a-shift-strong").map((m) => m.text())).toEqual(["{", "}"]);
    // オーバーレイの文字列は入力欄の値と 1 文字も違わない（違うと桁がずれて見える）
    const value = (w.find("input.grid-input").element as HTMLInputElement).value;
    expect(overlay.element.textContent).toBe(value);
    expect(value.startsWith("{取引}")).toBe(true);
    w.unmount();
  });
});
