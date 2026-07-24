import { describe, it, expect, vi } from "vitest";
import { mount } from "@vue/test-utils";
import { nextTick } from "vue";
import ScreenGrid from "../src/components/ScreenGrid.vue";
import type { ScreenSnapshot, Cell, Field } from "@as400web/core";

/**
 * **矩形コピーは SO/SI を桁として写さない。**
 *
 * SO/SI は DBCS のデータではなく構造で、貼り付け先の欄が全角ランに合わせて付け直す。
 * 空白として写すと、貼り付けたときに「元の SO/SI ぶんの空白」＋「付け直された SO/SI」で
 * 桁が二重になる。`{ }` 表示（showShiftMarks）中は、その表示マークがそのまま文字として
 * クリップボードへ乗っていた。
 */
function cell(char = " ", extra: Partial<Cell> = {}): Cell {
  return {
    char, kind: "sbcs", color: "green", reverse: false, underline: false,
    blink: false, columnSeparator: false, nonDisplay: false, ...extra
  };
}

function blank(): Cell[][] {
  const cells: Cell[][] = [];
  for (let r = 0; r < 24; r++) {
    const row: Cell[] = [];
    for (let c = 0; c < 80; c++) row.push(cell());
    cells.push(row);
  }
  return cells;
}

/** 桁 col から列ビュー "{あい}" を置く（SO・全角 2・SI ＝ 6 桁） */
function putDbcs(cells: Cell[][], row: number, col: number): void {
  const r = cells[row - 1]!;
  let c = col - 1;
  r[c++] = cell(" ", { kind: "so" });
  r[c++] = cell("あ", { kind: "dbcs-lead" });
  r[c++] = cell("", { kind: "dbcs-tail" });
  r[c++] = cell("い", { kind: "dbcs-lead" });
  r[c++] = cell("", { kind: "dbcs-tail" });
  r[c++] = cell(" ", { kind: "si" });
}

const FIELD: Field = {
  index: 1, row: 5, col: 10, length: 10,
  protected: false, hidden: false, numeric: false, dbcsType: "open", mdt: false, value: ""
};

/** 桁 10..15（"{あい}" 全体）を矩形選択してコピーし、クリップボードの文字列を返す */
async function copyDbcsRect(opts: { field?: Field; showShiftMarks: boolean }): Promise<string> {
  const cells = blank();
  putDbcs(cells, 5, 10);
  const snapshot: ScreenSnapshot = {
    sessionId: "s", rows: 24, cols: 80, cursor: { row: 1, col: 1 },
    keyboardLocked: false, cells, fields: opts.field ? [opts.field] : []
  };
  const w = mount(ScreenGrid, {
    props: { snapshot, edits: new Map(), focused: true, showShiftMarks: opts.showShiftMarks },
    attachTo: document.body
  });
  await nextTick();
  (w.vm as unknown as { setBlockSelection: (r: unknown) => void }).setBlockSelection({ r1: 5, c1: 10, r2: 5, c2: 15 });
  const cd = { setData: vi.fn() };
  const ev = new Event("copy") as Event & { clipboardData: typeof cd };
  ev.clipboardData = cd;
  document.dispatchEvent(ev);
  w.unmount();
  return cd.setData.mock.calls[0]?.[1] as string;
}

describe("DBCS の矩形コピー", () => {
  it("入力欄の SO/SI は桁として写さない（貼り付けで二重にならない）", async () => {
    expect(await copyDbcsRect({ field: FIELD, showShiftMarks: false })).toBe("あい");
  });

  it("{ } 表示中でもマークは文字として乗らない", async () => {
    expect(await copyDbcsRect({ field: FIELD, showShiftMarks: true })).toBe("あい");
  });

  it("保護テキスト（欄外）の SO/SI も同じ扱い", async () => {
    expect(await copyDbcsRect({ showShiftMarks: false })).toBe("あい");
    expect(await copyDbcsRect({ showShiftMarks: true })).toBe("あい");
  });
});

/**
 * **全角の片側しか矩形に入っていない桁は、何もコピーしない（空白も置かない）。**
 * 写す物が 1 つも無い選択では、クリップボード自体を書き換えない。
 */
async function copyRange(c1: number, c2: number, field?: Field): Promise<string | undefined> {
  const cells = blank();
  putDbcs(cells, 5, 10); // 桁10=SO, 11-12=あ, 13-14=い, 15=SI
  const snapshot: ScreenSnapshot = {
    sessionId: "s", rows: 24, cols: 80, cursor: { row: 1, col: 1 },
    keyboardLocked: false, cells, fields: field ? [field] : []
  };
  const w = mount(ScreenGrid, {
    props: { snapshot, edits: new Map(), focused: true, showShiftMarks: false },
    attachTo: document.body
  });
  await nextTick();
  (w.vm as unknown as { setBlockSelection: (r: unknown) => void }).setBlockSelection({ r1: 5, c1, r2: 5, c2 });
  const cd = { setData: vi.fn() };
  const ev = new Event("copy") as Event & { clipboardData: typeof cd };
  ev.clipboardData = cd;
  document.dispatchEvent(ev);
  w.unmount();
  // setData を呼ばなければ undefined（＝クリップボードを書き換えていない）
  return cd.setData.mock.calls[0]?.[1] as string | undefined;
}

describe("全角を半分だけ含む矩形", () => {
  for (const [label, field] of [["入力欄", FIELD], ["保護テキスト", undefined]] as const) {
    it(`${label}: 右端が前半桁なら、その全角は含めない`, async () => {
      // 桁 10..13 = SO・あ・(あ後半)・い前半 → "あ" だけ（い は半分なので写さない）
      expect(await copyRange(10, 13, field)).toBe("あ");
    });

    it(`${label}: 左端が後半桁なら、その全角は含めない`, async () => {
      // 桁 12..15 = あ後半・い・SI → "い" だけ（あ は半分なので写さない）
      expect(await copyRange(12, 15, field)).toBe("い");
    });

    it(`${label}: 全角 1 文字の前半だけ（1 桁選択）はクリップボードを書き換えない`, async () => {
      expect(await copyRange(11, 11, field)).toBeUndefined();
    });

    it(`${label}: SO/SI だけの選択もクリップボードを書き換えない`, async () => {
      expect(await copyRange(10, 10, field)).toBeUndefined();
    });

    it(`${label}: 両側が入っていれば従来どおり全角を含める`, async () => {
      expect(await copyRange(11, 14, field)).toBe("あい");
    });
  }
});
