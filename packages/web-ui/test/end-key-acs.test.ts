import { describe, it, expect, beforeEach } from "vitest";
import { mount } from "@vue/test-utils";
import { nextTick } from "vue";
import ScreenGrid from "../src/components/ScreenGrid.vue";
import EmulatorPane from "../src/components/EmulatorPane.vue";
import { sessionsStore } from "../src/stores/sessions.js";
import { end, continuedEnd, type EditState } from "../src/composables/fieldEdit.js";
import { endInProtectedField } from "../src/composables/useCursor.js";
import type { ScreenSnapshot, Cell, Field } from "@ts5250/tn5250";
import type { WsClient } from "../src/ws-client.js";

/**
 * **End の行き先（行をまたぐ欄・継続欄）**。節目の点検の指摘（`20260921-acs-default-keys` / `20260921-end-outside-field`）。
 * - 行をまたぐ欄: ACS `processEndField` はカーソルの行の先頭を下限に `Field5250.getEndPosition` を呼ぶ——今の行より前は探さず、無ければ今の行の先頭
 * - 継続欄: ACS `FFT5250.getEndPositionOfContField`——最後の区切りから遡り、入力のある区切りの中で入力の直後（埋まっていればその桁）
 */
const cell = (): Cell =>
  ({ char: " ", kind: "sbcs", color: "green", reverse: false, underline: false, blink: false, columnSeparator: false, nonDisplay: false }) as Cell;
const snap = (fields: Field[], cursor = { row: 1, col: 1 }): ScreenSnapshot => ({
  sessionId: "s1", rows: 24, cols: 80, cursor, keyboardLocked: false,
  cells: Array.from({ length: 24 }, () => Array.from({ length: 80 }, cell)), fields
});
const st = (s: string): EditState => ({ chars: [...s], cursor: 0, insertMode: false }) as EditState;

beforeEach(() => document.body.replaceChildren());

describe("純ロジック", () => {
  it("`end` の下限: 下限より後に入力が無ければ下限、あれば入力の直後", () => {
    expect(end(st("ABC       "), 5).cursor).toBe(5);
    expect(end(st("ABC    X  "), 5).cursor).toBe(8);
    expect(end(st("ABC       ")).cursor).toBe(3);
  });
  it("`continuedEnd`: 最後の区切りから遡る。区切りの最後の桁まで埋まっていればその桁", () => {
    expect(continuedEnd([..."ABCDEFG   "], [5, 5])).toBe(7); // 2 つ目の区切りの FG の直後
    expect(continuedEnd([..."ABCDE     "], [5, 5])).toBe(4); // 2 つ目が空 → 1 つ目は埋まっているので E の上（区切りの境目ではない）
    expect(continuedEnd([..."AB        "], [5, 5])).toBe(2);
    expect(continuedEnd([..."          "], [5, 5])).toBe(0);
  });
});

describe("行をまたぐ欄の 2 行目で End", () => {
  it("**内容が 1 行目だけなら、2 行目の先頭に置く**（前の行へ戻らない。ACS と同じ）", async () => {
    const f: Field = { index: 1, row: 20, col: 7, length: 153, protected: false, hidden: false, numeric: false, mdt: false, value: "ABC" };
    const w = mount(ScreenGrid, { props: { snapshot: snap([f]), edits: new Map(), focused: false }, attachTo: document.body });
    const second = w.findAll("input.grid-input")[1]!;
    await second.trigger("focus");
    (second.element as HTMLInputElement).setSelectionRange(5, 5);
    await second.trigger("keydown", { key: "End" });
    const cur = (w.emitted("cursor") as [number, number][]).at(-1);
    expect(cur, "前の行へ戻った").toEqual([21, 1]);
    w.unmount();
  });
});

describe("継続欄の End", () => {
  const SID = "s1";
  const segs = (): Field[] => [
    { index: 1, row: 5, col: 10, length: 5, protected: false, hidden: false, numeric: false, mdt: false, value: "ABCDE", continued: "first" } as Field,
    { index: 2, row: 6, col: 10, length: 5, protected: false, hidden: false, numeric: false, mdt: false, value: "FG", continued: "last" } as Field
  ];
  function seed(fields: Field[], cursor: { row: number; col: number }): void {
    sessionsStore.byId.clear();
    sessionsStore.order = [];
    sessionsStore.add({
      sessionId: SID, label: "t", snapshot: snap(fields, cursor), edits: new Map(), cursor,
      link: { state: "connected" }, resumability: "resumable", readOnly: false,
      client: { send: () => {} } as unknown as WsClient
    });
  }
  const ins = (w: ReturnType<typeof mount>) =>
    Array.from(w.element.querySelectorAll("input.grid-input:not([readonly])")) as HTMLInputElement[];

  it("**欄の中の End は鎖の最後の入力の直後**（2 つ目の区切りの FG の直後）", async () => {
    seed(segs(), { row: 5, col: 10 });
    const w = mount(EmulatorPane, { props: { sessionId: SID, focused: true }, attachTo: document.body });
    await nextTick();
    const els = ins(w);
    els[0]!.focus();
    els[0]!.setSelectionRange(0, 0);
    els[0]!.dispatchEvent(new KeyboardEvent("keydown", { key: "End", bubbles: true, cancelable: true }));
    await nextTick();
    expect(document.activeElement, "区切り 1 つの中に留まった").toBe(els[1]);
    expect(els[1]!.selectionStart).toBe(2);
    w.unmount();
  });

  it("欄の外の End も同じ所へ", async () => {
    seed(segs(), { row: 1, col: 1 });
    const w = mount(EmulatorPane, { props: { sessionId: SID, focused: true }, attachTo: document.body });
    await nextTick();
    await w.find(".pane").trigger("keydown", { key: "End" });
    const els = ins(w);
    expect(document.activeElement).toBe(els[1]);
    expect(els[1]!.selectionStart).toBe(2);
    w.unmount();
  });
});

describe("保護（バイパス）欄の上で End", () => {
  // ACS `processEndField` は保護欄も `FFT5250.getField` で拾い、その欄の中の `getEndPosition` へ置く（次の入力欄へは飛ばない）
  const SID = "s1";
  const prot: Field = { index: 1, row: 3, col: 10, length: 5, protected: true, hidden: false, numeric: false, mdt: false, value: "AB" };
  const input: Field = { index: 2, row: 5, col: 10, length: 5, protected: false, hidden: false, numeric: false, mdt: false, value: "" };
  function withText(s: ScreenSnapshot, row: number, col: number, text: string): ScreenSnapshot {
    [...text].forEach((ch, i) => { s.cells[row - 1]![col - 1 + i]!.char = ch; });
    return s;
  }
  it("純ロジック: 入力の直後。最後の桁まで埋まっていればその桁、空なら探した下限", () => {
    const cells = (t: string) => withText(snap([prot]), 3, 10, t).cells;
    expect(endInProtectedField(prot, 3, cells("AB"), 80)).toEqual({ row: 3, col: 12 });
    expect(endInProtectedField(prot, 3, cells("ABCDE"), 80)).toEqual({ row: 3, col: 14 });
    expect(endInProtectedField(prot, 3, cells(""), 80)).toEqual({ row: 3, col: 10 });
    // 行をまたぐ欄は今の行の先頭が下限（入力欄と同じ）
    const wide: Field = { ...prot, row: 3, col: 78, length: 6 };
    expect(endInProtectedField(wide, 4, withText(snap([wide]), 3, 78, "AB").cells, 80)).toEqual({ row: 4, col: 1 });
  });
  it("**その欄の中の末尾へ移り、次の入力欄へは飛ばない**", async () => {
    sessionsStore.byId.clear();
    sessionsStore.order = [];
    const cursor = { row: 3, col: 10 };
    const sent: Array<Record<string, unknown>> = [];
    sessionsStore.add({
      sessionId: SID, label: "t", snapshot: withText(snap([prot, input], cursor), 3, 10, "AB"), edits: new Map(), cursor,
      link: { state: "connected" }, resumability: "resumable", readOnly: false,
      client: { send: (m: Record<string, unknown>) => sent.push(m) } as unknown as WsClient
    });
    const w = mount(EmulatorPane, { props: { sessionId: SID, focused: true }, attachTo: document.body });
    await nextTick();
    await w.find(".pane").trigger("keydown", { key: "End" });
    expect((document.activeElement as HTMLElement | null)?.dataset?.["fieldIndex"], "次の入力欄へ飛んだ").not.toBe("2");
    // カーソルは送る AID の位置で見る（ペインのカーソルは表示用の上書きに持つ）
    await w.find(".pane").trigger("keydown", { key: "F3" });
    expect(sent.find((m) => m["type"] === "key")).toMatchObject({ key: "F3", cursor: { row: 3, col: 12 } });
    w.unmount();
  });
});
