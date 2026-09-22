import { describe, it, expect, beforeEach } from "vitest";
import { mount } from "@vue/test-utils";
import { nextTick } from "vue";
import ScreenGrid from "../src/components/ScreenGrid.vue";
import type { ScreenSnapshot, Cell, Field } from "@ts5250/tn5250";
import { MSG_MANDATORY_ENTER_EXIT, MSG_MANDATORY_FILL } from "../src/composables/opMessages.js";
import { fieldExitRejection, findMandatoryEnterViolation, findFieldViolation } from "../src/composables/mandatoryCheck.js";

/**
 * **Field Exit の検査の「欄の先頭」と MDT を ACS と同じにする**（`20260921-field-exit-checks` の節目の独立点検の指摘）。
 *
 * - 「欄の先頭」は ACS の `cursorSBA == startPos`。先頭が SO の DBCS 欄（J）では最初の字は `startPos+1`（Tab で入った位置）なので先頭ではない
 * - ACS `PS5250.inputChar` / `insertChar` は字を置けば値が変わらなくても `setMDT` する
 * - ACS `PS5250.setMDT` は継続欄の並びの全区間に MDT を立てる
 */
const COLS = 80;
function cell(char = " ", kind: Cell["kind"] = "sbcs"): Cell {
  return { char, kind, color: "green", reverse: false, underline: false, blink: false, columnSeparator: false, nonDisplay: false } as Cell;
}
function snapOf(fields: Field[], put: (cells: Cell[][]) => void = () => {}): ScreenSnapshot {
  const cells: Cell[][] = [];
  for (let r = 1; r <= 24; r++) cells.push(Array.from({ length: COLS }, () => cell()));
  put(cells);
  return { sessionId: "s", rows: 24, cols: COLS, cursor: { row: 5, col: 11 }, keyboardLocked: false, cells, fields } as unknown as ScreenSnapshot;
}
const NEXT = { index: 2, row: 7, col: 10, length: 6, protected: false, hidden: false, numeric: false, mdt: false, value: "" } as Field;

async function exitFrom(snapshot: ScreenSnapshot, prepare: (el: HTMLInputElement) => Promise<void>) {
  // 親（ペイン）と同じく、編集を受けたら同じ Map に入れる（ScreenGrid は props の Map を見て MDT を判定する）
  const edits = new Map<number, string>();
  const w = mount(ScreenGrid, {
    props: { snapshot, edits, focused: true, busy: false, cursor: snapshot.cursor, onEdit: (i: number, v: string) => void edits.set(i, v) },
    attachTo: document.body
  });
  await nextTick();
  const el = w.element.querySelector("input.grid-input:not([readonly])") as HTMLInputElement;
  el.focus();
  await prepare(el);
  (w.vm as unknown as { fieldExit: () => void }).fieldExit();
  await nextTick();
  const notices = ((w.emitted("notice") as unknown[][] | undefined) ?? []).map((a) => a[0]);
  const emitted = ((w.emitted("edit") as unknown[][] | undefined) ?? []).map((a) => a[1]);
  const moved = ((w.emitted("field-full") as unknown[][] | undefined) ?? []).length;
  w.unmount();
  return { notices, edits: emitted, moved };
}

describe("DBCS（J）欄の最初の字は「欄の先頭」ではない（SO の次の桁＝ACS の startPos+1）", () => {
  beforeEach(() => document.body.replaceChildren());
  /** (5,10) から 8 桁の J 欄: SO あ SI ＋空白。MDT あり */
  const jSnap = (over: Partial<Field>) =>
    snapOf(
      [{ index: 1, row: 5, col: 10, length: 8, protected: false, hidden: false, numeric: false, mdt: true, value: "あ", dbcsType: "only", ...over } as Field, NEXT],
      (cells) => {
        const r = cells[4]!;
        r[9] = cell(" ", "so");
        r[10] = cell("あ", "dbcs-lead");
        r[11] = cell("", "dbcs-tail");
        r[12] = cell(" ", "si");
      }
    );
  const atFirstChar = async (el: HTMLInputElement) => {
    el.setSelectionRange(1, 1); // SO の次＝最初の全角
    el.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await nextTick();
  };

  it("ME・MDT あり: 最初の字で Field Exit しても止めない（ACS は先頭でなく MDT もあるので通す）", async () => {
    const r = await exitFrom(jSnap({ mandatoryEnter: true }), atFirstChar);
    expect(r.notices).not.toContain(MSG_MANDATORY_ENTER_EXIT);
    expect(r.moved).toBe(1);
  });

  it("MF・部分入力: 最初の字で Field Exit したら 0014 で止め、値を消さない（ACS は先頭でないので MF を見る）", async () => {
    const r = await exitFrom(jSnap({ adjust: "mandatory-fill" }), atFirstChar);
    expect(r.notices).toContain(MSG_MANDATORY_FILL);
    expect(r.edits).toEqual([]);
    expect(r.moved).toBe(0);
  });
});

describe("字を置けば値が変わらなくても MDT（ACS `inputChar` の `setMDT`）", () => {
  beforeEach(() => document.body.replaceChildren());
  it("ホストの値 AB の ME 欄の先頭に A を打ち直して Field Exit → 止めない（編集も出る）", async () => {
    const f1 = { index: 1, row: 5, col: 10, length: 6, protected: false, hidden: false, numeric: false, mdt: false, value: "AB", mandatoryEnter: true } as Field;
    const snap = snapOf([f1, NEXT], (cells) => {
      cells[4]![9] = cell("A");
      cells[4]![10] = cell("B");
    });
    const r = await exitFrom(snap, async (el) => {
      el.setSelectionRange(0, 0);
      el.dispatchEvent(new KeyboardEvent("keydown", { key: "A", bubbles: true, cancelable: true }));
      await nextTick();
    });
    expect(r.notices).not.toContain(MSG_MANDATORY_ENTER_EXIT);
    expect(r.edits[0]).toBe("AB");
    expect(r.moved).toBe(1);
  });

  /** ホストの値と同じ字を置いたときに出た編集（無ければ空） */
  async function editsAfter(f1: Field, put: (cells: Cell[][]) => void, act: (el: HTMLInputElement) => Promise<void>): Promise<unknown[]> {
    const w = mount(ScreenGrid, {
      props: { snapshot: snapOf([f1, NEXT], put), edits: new Map(), focused: true, busy: false, cursor: { row: 5, col: 10 } },
      attachTo: document.body
    });
    await nextTick();
    const el = w.element.querySelector("input.grid-input:not([readonly])") as HTMLInputElement;
    el.focus();
    await act(el);
    const out = ((w.emitted("edit") as unknown[][] | undefined) ?? []).map((a) => a[1]);
    w.unmount();
    return out;
  }
  const jField = { index: 1, row: 5, col: 10, length: 8, protected: false, hidden: false, numeric: false, mdt: false, value: "あ", dbcsType: "only" } as Field;
  const jCells = (cells: Cell[][]) => {
    const r = cells[4]!;
    r[9] = cell(" ", "so");
    r[10] = cell("あ", "dbcs-lead");
    r[11] = cell("", "dbcs-tail");
    r[12] = cell(" ", "si");
  };
  const atFirst = async (el: HTMLInputElement) => {
    el.setSelectionRange(1, 1);
    el.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await nextTick();
  };

  it("DBCS 欄で同じ全角を打ち直しても編集が出る", async () => {
    const out = await editsAfter(jField, jCells, async (el) => {
      await atFirst(el);
      el.dispatchEvent(new KeyboardEvent("keydown", { key: "あ", bubbles: true, cancelable: true }));
      await nextTick();
    });
    expect(out).toEqual(["あ"]);
  });

  it("DBCS 欄に同じ全角を貼っても編集が出る（ACS の貼り付けは 1 字ずつの打鍵）", async () => {
    const out = await editsAfter(jField, jCells, async (el) => {
      await atFirst(el);
      const ev = new Event("paste", { bubbles: true, cancelable: true }) as Event & { clipboardData: unknown };
      ev.clipboardData = { getData: () => "あ" };
      el.dispatchEvent(ev);
      await nextTick();
    });
    expect(out).toEqual(["あ"]);
  });

  it("IME で同じ字を確定しても編集が出る", async () => {
    const f1 = { index: 1, row: 5, col: 10, length: 6, protected: false, hidden: false, numeric: false, mdt: false, value: "AB" } as Field;
    const out = await editsAfter(
      f1,
      (cells) => {
        cells[4]![9] = cell("A");
        cells[4]![10] = cell("B");
      },
      async (el) => {
        el.setSelectionRange(0, 0);
        el.dispatchEvent(new CompositionEvent("compositionstart"));
        await nextTick();
        el.value = el.value + "A"; // 確定した字（prefix の後ろ）
        el.dispatchEvent(new CompositionEvent("compositionend"));
        await nextTick();
      }
    );
    expect(out).toEqual(["AB"]);
  });

  it("カーソルを動かすだけでは MDT にしない（従来どおり）", async () => {
    const f1 = { index: 1, row: 5, col: 10, length: 6, protected: false, hidden: false, numeric: false, mdt: false, value: "AB" } as Field;
    const w = mount(ScreenGrid, { props: { snapshot: snapOf([f1, NEXT]), edits: new Map(), focused: true, busy: false, cursor: { row: 5, col: 10 } }, attachTo: document.body });
    await nextTick();
    const el = w.element.querySelector("input.grid-input:not([readonly])") as HTMLInputElement;
    el.focus();
    el.setSelectionRange(1, 1);
    el.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true, cancelable: true }));
    await nextTick();
    expect(w.emitted("edit")).toBeUndefined();
    w.unmount();
  });
});

describe("継続欄は並びのどこかに MDT があれば全区間が MDT（ACS `PS5250.setMDT`）", () => {
  const seg = (index: number, col: number, continued: Field["continued"], over: Partial<Field> = {}): Field =>
    ({ index, row: 5, col, length: 2, protected: false, hidden: false, numeric: false, mdt: false, value: "", continued, ...over }) as Field;
  const s1 = seg(1, 10, "first", { mandatoryEnter: true });
  const s2 = seg(2, 13, "last", { mandatoryEnter: true });
  const other = seg(3, 20, undefined, { mandatoryEnter: true, mdt: true });

  it("1 区間目だけ打った ME の継続欄: 2 区間目で Field Exit しても止めない", () => {
    expect(fieldExitRejection(s2, new Map([[1, "12"]]), false, [s1, s2, other])).toBeUndefined();
    // 並びを渡さなければその区間だけを見る（呼び出し側は画面の全欄を渡す）
    expect(fieldExitRejection(s2, new Map([[1, "12"]]), false)).toBe("mandatory-enter");
  });

  it("AID の ME の検査も並びで見る（1 区間目だけ打てば 2 区間目も通る）", () => {
    expect(findMandatoryEnterViolation([s1, s2, other], new Map([[1, "12"]]))).toBeUndefined();
    expect(findMandatoryEnterViolation([s1, s2, other], new Map([[3, "X"]]))?.field.index).toBe(1);
  });

  it("別の並び・単独欄の MDT は数えない", () => {
    const t1 = seg(4, 30, "first", { mandatoryEnter: true });
    const t2 = seg(5, 33, "last", { mandatoryEnter: true });
    expect(fieldExitRejection(t2, new Map([[1, "12"]]), false, [s1, s2, other, t1, t2])).toBe("mandatory-enter");
  });

  it("MF の検査も並びの MDT で見る", () => {
    const m1 = seg(1, 10, "first", { adjust: "mandatory-fill" });
    const m2 = seg(2, 13, "last", { adjust: "mandatory-fill", value: "1" });
    expect(findFieldViolation(m2, new Map(), [m1, m2])).toBeUndefined(); // どこも MDT なし
    expect(findFieldViolation(m2, new Map([[1, "12"]]), [m1, m2])?.reason).toBe("mandatory-fill");
  });
});
