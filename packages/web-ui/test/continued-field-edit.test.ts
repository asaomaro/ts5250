import { describe, it, expect, beforeEach } from "vitest";
import { mount } from "@vue/test-utils";
import { nextTick } from "vue";
import ScreenGrid from "../src/components/ScreenGrid.vue";
import type { Cell, Field, ScreenSnapshot } from "@ts5250/tn5250";

/**
 * **EDTMSK で分割された欄は、ACS と同じく「1 つの入力欄」として編集する。**
 *
 * ホストは EDTMSK で割った数値欄を、区切り文字（`/`）を挟んだ**複数の別々の欄**として送る
 * （`Field.continued` = first/middle/last）。区間ごとに独立した input として扱うと
 * **Backspace / Delete が区切りの前後で止まる**——実機（`ASAOLIB/DTMPGM` の `D8U`）で
 * `2026/08/25` の末尾から Backspace を 3 回押しても `2026/08/` までしか消えず、
 * 先頭で Delete を押しても最初の区間しか詰まらなかった。
 *
 * 区間の値を連結した合成バッファへ `fieldEdit` の純関数を当て、結果を区間ごとに割り戻す。
 */

const COLS = 80;
const ROW = 3;

function cell(char = " "): Cell {
  return { char, kind: "sbcs", color: "green", reverse: false, underline: false,
    blink: false, columnSeparator: false, nonDisplay: false } as Cell;
}
function fld(over: Partial<Field> & { index: number; col: number; length: number }): Field {
  return { row: ROW, protected: false, hidden: false, numeric: true, mdt: false, value: "", ...over } as Field;
}
function snapOf(fields: Field[]): ScreenSnapshot {
  const cells: Cell[][] = [];
  for (let r = 1; r <= 24; r++) {
    const row: Cell[] = [];
    for (let c = 1; c <= COLS; c++) row.push(cell());
    cells.push(row);
  }
  for (const f of fields) [...f.value].forEach((ch, i) => (cells[f.row - 1]![f.col - 1 + i] = cell(ch)));
  cells[ROW - 1]![27] = cell("/"); // 桁 28
  cells[ROW - 1]![30] = cell("/"); // 桁 31
  return { sessionId: "s", rows: 24, cols: COLS, cursor: { row: ROW, col: 24 },
    keyboardLocked: false, cells, fields } as unknown as ScreenSnapshot;
}
/** 実機と同じ `9999/99/99`（4 桁 ＋ `/` ＋ 2 桁 ＋ `/` ＋ 2 桁） */
const dateFields = (a = "2026", b = "08", c = "25"): Field[] => [
  fld({ index: 1, col: 24, length: 4, continued: "first", value: a }),
  fld({ index: 2, col: 29, length: 2, continued: "middle", value: b }),
  fld({ index: 3, col: 32, length: 2, continued: "last", value: c })
];

describe("EDTMSK 分割欄の Backspace / Delete は区間をまたぐ", () => {
  beforeEach(() => document.body.replaceChildren());

  // **親（EmulatorPane）と同じく emit された編集を `edits` へ書き戻す。**
  // ここを繋がないと、確定済みの区間が次の打鍵でホスト値へ巻き戻り、
  // 連続した Backspace が実機と違う結果になる（テスト側の作りの問題）。
  const edits = new Map<number, string>();
  function mountGrid(fields: Field[]) {
    edits.clear();
    return mount(ScreenGrid, {
      props: { snapshot: snapOf(fields), edits, focused: true, busy: false, cursor: { row: ROW, col: 24 } },
      attachTo: document.body
    });
  }
  function pumpEdits(w: ReturnType<typeof mountGrid>): void {
    for (const [idx, val] of (w.emitted("edit") as unknown[][] | undefined) ?? []) {
      edits.set(idx as number, val as string);
    }
  }
  const inputs = (w: ReturnType<typeof mountGrid>) =>
    Array.from(w.element.querySelectorAll('input.grid-input:not([readonly])[data-slice="0"]')) as HTMLInputElement[];
  /** 欄ごとの最新の値（emit された edit ＞ 元の値） */
  function values(w: ReturnType<typeof mountGrid>, fields: Field[]): string[] {
    const edits = new Map<number, string>();
    for (const [idx, val] of (w.emitted("edit") as unknown[][] | undefined) ?? []) {
      edits.set(idx as number, val as string);
    }
    return fields.map((f) => edits.get(f.index) ?? f.value);
  }
  async function press(w: ReturnType<typeof mountGrid>, el: HTMLInputElement, key: string) {
    el.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
    await nextTick();
    pumpEdits(w);
  }
  async function focusAt(w: ReturnType<typeof mountGrid>, i: number, caret: number) {
    const el = inputs(w)[i]!;
    el.focus();
    el.setSelectionRange(caret, caret);
    await nextTick();
    return el;
  }

  it("**末尾からの Backspace が区切りを越えて詰まる**（区間で止まらない）", async () => {
    const fields = dateFields();
    const w = mountGrid(fields);
    await nextTick();
    await focusAt(w, 2, 2);
    for (let i = 0; i < 3; i++) {
      const active = document.activeElement as HTMLInputElement;
      await press(w, active, "Backspace");
    }
    // "20260825" → 3 桁消えて "20260"
    expect(values(w, fields).join("")).toBe("20260");
    w.unmount();
  });

  it("**先頭からの Delete が後続の区間から桁を引き寄せる**", async () => {
    const fields = dateFields();
    const w = mountGrid(fields);
    await nextTick();
    await focusAt(w, 0, 0);
    await press(w, inputs(w)[0]!, "Delete");
    // "20260825" → 先頭を消して "0260825"（区間へ割り戻すと 0260 / 82 / 5）
    expect(values(w, fields)).toEqual(["0260", "82", "5"]);
    w.unmount();
  });

  it("並び全体の先頭では削除せず前の欄へ移る（単独欄と同じ）", async () => {
    const fields = dateFields();
    const w = mountGrid(fields);
    await nextTick();
    await focusAt(w, 0, 0);
    await press(w, inputs(w)[0]!, "Backspace");
    expect(w.emitted("field-prev")).toBeTruthy();
    expect(values(w, fields)).toEqual(["2026", "08", "25"]); // 何も消えない
    w.unmount();
  });

  it("中間区間の先頭で Backspace すると前の区間の末尾が消える", async () => {
    const fields = dateFields();
    const w = mountGrid(fields);
    await nextTick();
    await focusAt(w, 1, 0);
    await press(w, inputs(w)[1]!, "Backspace");
    // "20260825" の 4 桁目が消えて "2020825" → 2020 / 82 / 5
    expect(values(w, fields)).toEqual(["2020", "82", "5"]);
    w.unmount();
  });

  it("単独欄（`continued` 無し）は従来どおり欄の中だけで詰まる（退行防止）", async () => {
    const fields = [fld({ index: 1, col: 24, length: 4, value: "2026" })];
    const w = mountGrid(fields);
    await nextTick();
    await focusAt(w, 0, 4);
    await press(w, inputs(w)[0]!, "Backspace");
    expect(values(w, fields)).toEqual(["202"]);
    w.unmount();
  });
});
