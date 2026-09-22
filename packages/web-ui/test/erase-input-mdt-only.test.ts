import { describe, it, expect, beforeEach } from "vitest";
import { mount } from "@vue/test-utils";
import { nextTick } from "vue";
import ScreenGrid from "../src/components/ScreenGrid.vue";
import type { Cell, Field, ScreenSnapshot } from "@ts5250/tn5250";

/**
 * **Erase Input は MDT の立った欄だけを消す**（`20260921-erase-input-mdt-only`）。
 *
 * ACS `PS5250.processEraseInput` は `clearNonbypassFields(true)`（MDT の立った欄のみ）を呼ぶ。
 * 以前は「中身のある全欄」を消しており、ホストが既定値を入れた**未変更の欄**
 * （プロンプタの `*LIBL` など）まで消え、空白が「変更」として送られていた。
 * 既定の割り当ては Ctrl+Backspace で、Windows の「前の単語を削除」の癖で押されうる。
 */
const COLS = 80;
const cell = (char = " "): Cell =>
  ({ char, kind: "sbcs", color: "green", reverse: false, underline: false,
     blink: false, columnSeparator: false, nonDisplay: false }) as Cell;
const fld = (o: Partial<Field> & { index: number; row: number; col: number; length: number }): Field =>
  ({ protected: false, hidden: false, numeric: false, mdt: false, value: "", ...o }) as Field;
function snapOf(fields: Field[]): ScreenSnapshot {
  const cells: Cell[][] = [];
  for (let r = 1; r <= 24; r++) { const row: Cell[] = []; for (let c = 1; c <= COLS; c++) row.push(cell()); cells.push(row); }
  for (const f of fields) [...f.value].forEach((ch, i) => (cells[f.row - 1]![f.col - 1 + i] = cell(ch)));
  return { sessionId: "s", rows: 24, cols: COLS, cursor: { row: 5, col: 10 },
    keyboardLocked: false, cells, fields } as unknown as ScreenSnapshot;
}

describe("Erase Input は MDT の立った欄だけを消す", () => {
  beforeEach(() => document.body.replaceChildren());

  function run(fields: Field[], edits: Map<number, string>) {
    const w = mount(ScreenGrid, {
      props: { snapshot: snapOf(fields), edits, focused: true, busy: false, cursor: { row: 5, col: 10 } },
      attachTo: document.body
    });
    (w.vm as unknown as { eraseInput: () => void }).eraseInput();
    const cleared = ((w.emitted("edit") as unknown[][] | undefined) ?? []).map((a) => a[0] as number);
    w.unmount();
    return cleared;
  }

  it("ホストが既定値を入れた未変更の欄（*LIBL）は消さない", () => {
    const cleared = run(
      [fld({ index: 1, row: 5, col: 10, length: 10, value: "*LIBL" })], // mdt=false・未編集
      new Map()
    );
    expect(cleared, "未変更の既定値を消すと、空白が『変更』として送られる").not.toContain(1);
  });

  it("利用者が打った欄は消す", () => {
    const cleared = run(
      [fld({ index: 1, row: 5, col: 10, length: 10, value: "" })],
      new Map([[1, "ABC"]]) // 利用者の編集＝MDT が立つ
    );
    expect(cleared).toContain(1);
  });

  it("ホストが MDT を立てて送った欄は消す", () => {
    const cleared = run(
      [fld({ index: 1, row: 5, col: 10, length: 10, value: "XYZ", mdt: true })],
      new Map()
    );
    expect(cleared).toContain(1);
  });

  it("混在していても、MDT の立った欄だけが消える", () => {
    const cleared = run(
      [
        fld({ index: 1, row: 5, col: 10, length: 10, value: "*LIBL" }),        // 既定値・未変更
        fld({ index: 2, row: 6, col: 10, length: 10, value: "" }),             // 利用者が打つ
        fld({ index: 3, row: 7, col: 10, length: 10, value: "KEEP" })          // 既定値・未変更
      ],
      new Map([[2, "TYPED"]])
    );
    expect(cleared).toEqual([2]);
  });
});
