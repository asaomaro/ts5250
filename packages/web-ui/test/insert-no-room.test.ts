import { describe, it, expect, beforeEach } from "vitest";
import { mount } from "@vue/test-utils";
import { nextTick } from "vue";
import ScreenGrid from "../src/components/ScreenGrid.vue";
import { insertChar, typeChar, initEdit, toggleInsert, editValue, type EditState } from "../src/composables/fieldEdit.js";
import { MSG_NO_ROOM, MSG_FIELD_EXIT_KEY_INVALID } from "../src/composables/opMessages.js";
import type { Cell, Field, ScreenSnapshot } from "@ts5250/tn5250";

/**
 * **挿入モードで余地が無いときは ACS と同じくエラー 0012 にし、値を変えない**（`20260921-insert-no-room`）。
 *
 * 以前は挿入のあと欄の長さで切り詰めていたので、末尾の字が黙って消えて送られ、符号付き数値欄では
 * 符号桁まで押し出して値が化けた（右寄せの `    12-`（−12）の先頭に 9 → `    912`）。
 *
 * 例はすべて実機の ACS のコアで測ったもの（research F3・F5。`scripts/acs-probe/insert-no-room.txt`・
 * `insert-no-room-continued.txt`）: 最終桁にカーソルなら空白でもエラー／途中の空白は数えない／
 * 行をまたぐ欄・継続欄は欄全体で押し出す／符号付きは符号桁の手前までで数え、符号桁は動かさない。
 */

const st = (chars: string, cursor: number): EditState => ({ chars: [...chars], cursor, insertMode: true });

describe("insertChar（純関数。ACS `reserveRoomForInsert`）", () => {
  it("末尾に空きがあれば押し出す（I1: ABC の先頭に X）", () => {
    const r = insertChar(st("ABC       ", 0), "X", 9)!;
    expect(r.chars.join("")).toBe("XABC      ");
    expect(r.cursor).toBe(1);
  });

  it("**最終桁にカーソルなら空白でも余地なし**（I2）", () => {
    expect(insertChar(st("          ", 9), "Y", 9)).toBeUndefined();
    // 最終桁の手前なら入る（最終桁の空白が押し出される）
    expect(insertChar(st("          ", 8), "Y", 9)!.chars.join("")).toBe("        Y ");
  });

  it("**途中の空白は数えない**——末尾が埋まっていれば余地なし（I4）", () => {
    expect(insertChar(st("DDDD DDDDD", 0), "Q", 9)).toBeUndefined();
  });

  it("満杯なら余地なし（I5）", () => {
    expect(insertChar(st("FFFFFFFFFF", 3), "Q", 9)).toBeUndefined();
  });

  it("NUL も空きとして数える", () => {
    expect(insertChar(st("AB\u0000\u0000", 0), "X", 3)!.chars.join("")).toBe("XAB\u0000");
  });

  it("**符号付き: 符号桁の手前までで数える**。右寄せの `    12-` には入らない（I6。以前は `    912` に化けた）", () => {
    expect(insertChar(st("    12-", 0), "9", 5)).toBeUndefined();
  });

  it("符号付き: 空きがあれば押し出し、**符号桁は動かない**（I7）", () => {
    expect(insertChar(st("12    -", 0), "9", 5)!.chars.join("")).toBe("912   -");
    expect(insertChar(st("12     ", 0), "9", 5)!.chars.join("")).toBe("912    ");
  });

  it("符号付き: 最終の数字桁（空白）には入り、カーソルは符号桁へ進む", () => {
    const r = insertChar(st("1234  -", 5), "9", 5)!;
    expect(r.chars.join("")).toBe("1234 9-");
    expect(r.cursor).toBe(6);
  });

  it("`typeChar` の挿入も余地が無ければ値を変えない（どの経路からでも黙って切り詰めない）", () => {
    let s = toggleInsert(initEdit("ABCDE", 5, 1));
    s = typeChar(s, "X");
    expect(editValue(s)).toBe("ABCDE");
    expect(s.cursor).toBe(1);
  });
});

const COLS = 80;
function cell(char = " "): Cell {
  return { char, kind: "sbcs", color: "green", reverse: false, underline: false,
    blink: false, columnSeparator: false, nonDisplay: false } as Cell;
}
function fld(over: Partial<Field> & { index: number; row: number; col: number; length: number }): Field {
  return { protected: false, hidden: false, numeric: false, mdt: false, value: "", ...over } as Field;
}
function snapOf(fields: Field[], seps: Array<[number, number]> = []): ScreenSnapshot {
  const cells: Cell[][] = [];
  for (let r = 1; r <= 24; r++) {
    const row: Cell[] = [];
    for (let c = 1; c <= COLS; c++) row.push(cell());
    cells.push(row);
  }
  for (const f of fields) {
    [...f.value].forEach((ch, i) => {
      const at = f.col - 1 + i;
      cells[f.row - 1 + Math.floor(at / COLS)]![at % COLS] = cell(ch);
    });
  }
  for (const [r, c] of seps) cells[r - 1]![c - 1] = cell("/");
  return { sessionId: "s", rows: 24, cols: COLS, cursor: { row: fields[0]!.row, col: fields[0]!.col },
    keyboardLocked: false, cells, fields } as unknown as ScreenSnapshot;
}

describe("ScreenGrid: 挿入モードの打鍵", () => {
  beforeEach(() => document.body.replaceChildren());

  const edits = new Map<number, string>();
  function mountGrid(fields: Field[], seps: Array<[number, number]> = []) {
    edits.clear();
    return mount(ScreenGrid, {
      props: { snapshot: snapOf(fields, seps), edits, focused: true, busy: false, cursor: { row: fields[0]!.row, col: fields[0]!.col } },
      attachTo: document.body
    });
  }
  const inputs = (w: ReturnType<typeof mountGrid>) =>
    Array.from(w.element.querySelectorAll('input.grid-input:not([readonly])[data-slice="0"]')) as HTMLInputElement[];
  const notices = (w: ReturnType<typeof mountGrid>) =>
    ((w.emitted("notice") as unknown[][] | undefined) ?? []).map((a) => a[0] as string);
  /** 欄ごとの最新の値（emit された edit ＞ 元の値） */
  function values(w: ReturnType<typeof mountGrid>, fields: Field[]): string[] {
    const m = new Map<number, string>();
    for (const [idx, val] of (w.emitted("edit") as unknown[][] | undefined) ?? []) m.set(idx as number, val as string);
    return fields.map((f) => m.get(f.index) ?? f.value);
  }
  async function press(el: HTMLInputElement, key: string) {
    el.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
    await nextTick();
  }
  /** 欄 i の caret に置いて Insert → 文字を打つ（ACS の `[insert]` → 文字） */
  async function insertAt(w: ReturnType<typeof mountGrid>, i: number, caret: number, text: string) {
    const el = inputs(w)[i]!;
    el.focus();
    el.setSelectionRange(caret, caret);
    await nextTick();
    await press(el, "Insert");
    for (const ch of text) await press(document.activeElement as HTMLInputElement, ch);
  }

  it("満杯の欄の途中に挿入するとエラー 0012、値は変わらない（I5）", async () => {
    const fields = [fld({ index: 1, row: 5, col: 10, length: 10, value: "FFFFFFFFFF" })];
    const w = mountGrid(fields);
    await nextTick();
    await insertAt(w, 0, 3, "Q");
    expect(notices(w)).toContain(MSG_NO_ROOM);
    expect(values(w, fields)).toEqual(["FFFFFFFFFF"]);
    w.unmount();
  });

  it("**行をまたぐ欄は欄全体で押し出す**（I3: 20 行を埋めて 21 行 1 字 → 21 行が `BC`）", async () => {
    const fields = [fld({ index: 1, row: 20, col: 7, length: 153, value: "B".repeat(74) + "C" })];
    const w = mountGrid(fields);
    await nextTick();
    await insertAt(w, 0, 0, "Z");
    expect(notices(w)).not.toContain(MSG_NO_ROOM);
    expect(values(w, fields)[0]).toBe("Z" + "B".repeat(74) + "C");
    w.unmount();
  });

  it("行をまたぐ欄の最終桁（21,79）では空白でもエラー（I2）", async () => {
    const fields = [fld({ index: 1, row: 20, col: 7, length: 153 })];
    const w = mountGrid(fields);
    await nextTick();
    // 2 つ目のスライス（21 行）の 79 桁目＝欄の最終桁
    const el = w.element.querySelector('input.grid-input:not([readonly])[data-slice="1"]') as HTMLInputElement;
    el.focus();
    el.setSelectionRange(78, 78);
    await nextTick();
    await press(el, "Insert");
    await press(document.activeElement as HTMLInputElement, "Y");
    expect(notices(w)).toContain(MSG_NO_ROOM);
    expect(w.emitted("edit")).toBeUndefined();
    w.unmount();
  });

  it("**符号付き: 右寄せの `    12-` の先頭に 9 → エラー 0012、値は −12 のまま**（台帳の再現手順）", async () => {
    const fields = [fld({ index: 1, row: 5, col: 10, length: 7, numeric: true, signedNumeric: true, value: "    12-" })];
    const w = mountGrid(fields);
    await nextTick();
    await insertAt(w, 0, 0, "9");
    expect(notices(w)).toContain(MSG_NO_ROOM);
    expect(values(w, fields)).toEqual(["    12-"]);
    w.unmount();
  });

  it("符号付き: **数字桁が埋まっていれば符号桁が空白でも入らない**（符号桁へ押し出さない）", async () => {
    const fields = [fld({ index: 1, row: 5, col: 10, length: 7, numeric: true, signedNumeric: true, value: "123456" })];
    const w = mountGrid(fields);
    await nextTick();
    await insertAt(w, 0, 0, "9");
    expect(notices(w)).toContain(MSG_NO_ROOM);
    expect(values(w, fields)).toEqual(["123456"]);
    w.unmount();
  });

  it("符号付き: 最終の数字桁に挿入すると「出た」状態になり、次の文字は 0018 ではなく 0012（カーソルは符号桁）", async () => {
    const fields = [fld({ index: 1, row: 5, col: 10, length: 7, numeric: true, signedNumeric: true, value: "1234" })];
    const w = mountGrid(fields);
    await nextTick();
    await insertAt(w, 0, 5, "9");
    expect(values(w, fields)).toEqual(["1234 9"]);
    expect(w.emitted("field-exited")).toBeTruthy();
    await press(document.activeElement as HTMLInputElement, "8");
    expect(notices(w)).toContain(MSG_NO_ROOM);
    expect(notices(w)).not.toContain(MSG_FIELD_EXIT_KEY_INVALID);
    w.unmount();
  });

  // 実機と同じ `9999/99/99`（DTMPGM の D8U。4 桁 ＋ `/` ＋ 2 桁 ＋ `/` ＋ 2 桁）
  const SEPS: Array<[number, number]> = [[3, 28], [3, 31]];
  const dateFields = (a: string, b: string, c: string): Field[] => [
    fld({ index: 1, row: 3, col: 24, length: 4, numeric: true, continued: "first", value: a }),
    fld({ index: 2, row: 3, col: 29, length: 2, numeric: true, continued: "middle", value: b }),
    fld({ index: 3, row: 3, col: 32, length: 2, numeric: true, continued: "last", value: c })
  ];

  it("**継続欄は全区間を 1 つの欄として押し出す**（C2: `1234/56/..` → `9123/45/6.`）", async () => {
    const fields = dateFields("1234", "56", "");
    const w = mountGrid(fields, SEPS);
    await nextTick();
    await insertAt(w, 0, 0, "9");
    expect(values(w, fields).map((v) => v.trimEnd())).toEqual(["9123", "45", "6"]);
    w.unmount();
  });

  it("継続欄: 最終区間の最終桁も数える（C6: `1234/56/7.` → `9123/45/67`）", async () => {
    const fields = dateFields("1234", "56", "7");
    const w = mountGrid(fields, SEPS);
    await nextTick();
    await insertAt(w, 0, 0, "9");
    expect(values(w, fields)).toEqual(["9123", "45", "67"]);
    w.unmount();
  });

  it("継続欄: 満杯ならエラー 0012、値は変わらない（C5）", async () => {
    const fields = dateFields("1234", "56", "78");
    const w = mountGrid(fields, SEPS);
    await nextTick();
    await insertAt(w, 0, 0, "9");
    expect(notices(w)).toContain(MSG_NO_ROOM);
    expect(values(w, fields)).toEqual(["1234", "56", "78"]);
    w.unmount();
  });

  it("継続欄: 空の欄の最終区間の最終桁ではエラー（C7）", async () => {
    const fields = dateFields("", "", "");
    const w = mountGrid(fields, SEPS);
    await nextTick();
    await insertAt(w, 2, 1, "9");
    expect(notices(w)).toContain(MSG_NO_ROOM);
    w.unmount();
  });

  it("継続欄: 区間の終わりに着いたら次の区間の先頭へ（ACS の挿入の枝）", async () => {
    const fields = dateFields("123", "", "");
    const w = mountGrid(fields, SEPS);
    await nextTick();
    await insertAt(w, 0, 3, "4");
    expect(values(w, fields).map((v) => v.trimEnd())).toEqual(["1234", "", ""]);
    const active = document.activeElement as HTMLInputElement;
    expect(active).toBe(inputs(w)[1]);
    expect(active.selectionStart).toBe(0);
    w.unmount();
  });

  it("IME 確定（SBCS）も余地を数える: 満杯の欄ではエラー 0012、末尾を捨てない", async () => {
    const fields = [fld({ index: 1, row: 5, col: 10, length: 5, value: "ABCDE" })];
    const w = mountGrid(fields);
    await nextTick();
    const el = inputs(w)[0]!;
    el.focus();
    el.setSelectionRange(1, 1);
    await nextTick();
    await press(el, "Insert");
    el.dispatchEvent(new CompositionEvent("compositionstart"));
    await nextTick();
    el.value = el.value + "X"; // 確定した字（prefix の後ろ）
    el.dispatchEvent(new CompositionEvent("compositionend"));
    await nextTick();
    expect(notices(w)).toContain(MSG_NO_ROOM);
    expect(values(w, fields)).toEqual(["ABCDE"]);
    w.unmount();
  });

  it("IME 確定で選択を置き換えた後の挿入も余地を数える（入らない字で 0012。黙って消さない。独立点検の指摘）", async () => {
    const fields = [fld({ index: 1, row: 5, col: 10, length: 5, value: "ABCDE" })];
    const w = mountGrid(fields);
    await nextTick();
    const el = inputs(w)[0]!;
    el.focus();
    el.setSelectionRange(0, 0);
    await nextTick();
    await press(el, "Insert");
    el.setSelectionRange(1, 2); // B を選ぶ
    el.dispatchEvent(new CompositionEvent("compositionstart"));
    await nextTick();
    el.value = el.value + "XY"; // 確定した 2 字（prefix の後ろ）
    el.dispatchEvent(new CompositionEvent("compositionend"));
    await nextTick();
    expect(values(w, fields)).toEqual(["AXCDE"]);
    expect(notices(w)).toContain(MSG_NO_ROOM);
    w.unmount();
  });

  it("DBCS 欄: 予算を越える挿入は拒否し、エラー 0012 を出す", async () => {
    const fields = [fld({ index: 1, row: 5, col: 10, length: 6, dbcsType: "open", value: "あい" })];
    const w = mountGrid(fields);
    await nextTick();
    const el = inputs(w)[0]!;
    el.focus();
    await nextTick();
    await press(el, "Insert");
    await press(document.activeElement as HTMLInputElement, "A");
    expect(notices(w)).toContain(MSG_NO_ROOM);
    w.unmount();
  });
});
