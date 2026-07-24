import { describe, it, expect } from "vitest";
import { mount } from "@vue/test-utils";
import { nextTick } from "vue";
import EmulatorPane from "../src/components/EmulatorPane.vue";
import { sessionsStore } from "../src/stores/sessions.js";
import type { ScreenSnapshot, Cell, Field } from "@as400web/core";
import type { WsClient } from "../src/ws-client.js";

/**
 * **Ctrl+矢印（カーソル頭出し）は入力欄の中でも画面の語頭へ飛ぶ（ACS 相当）。**
 *
 * 欄内で効かない原因が 3 つあった:
 *  1. 語の判定が `snapshot.cells`（＝ホストが描いた内容）だけを見ており、**欄に打った未送信の
 *     文字が語として見えず飛び越されていた**（`X   あ Y` の あ を打った直後の Ctrl+→ が Y へ）。
 *     コピー・ダブルクリック選択と同じ桁アクセサ（ScreenGrid.screenCharAt）で判定する。
 *  2. 全角の後半桁（char が `""`）を空白と見なしており、DBCS の語の中で 1 文字ずつ止まっていた。
 *  3. `reconcileFocus` は「既にフォーカス中の DBCS 欄」の caret を触らない設計（欄内の矢印移動は
 *     ScreenGrid が持つため）で、頭出しは ScreenGrid が動かさないので caret が居残っていた。
 */
const SID = "s1";

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

function seed(fields: Field[], cells: Cell[][], edits = new Map<number, string>()): void {
  const snapshot: ScreenSnapshot = {
    sessionId: SID, rows: 24, cols: 80, cursor: { row: 1, col: 1 },
    keyboardLocked: false, cells, fields
  };
  sessionsStore.byId.clear();
  sessionsStore.order = [];
  sessionsStore.add({
    sessionId: SID, label: "t", snapshot, edits,
    cursor: { row: 1, col: 1 }, connected: true, readOnly: false, client: {} as WsClient
  });
}

/** row/col（1 始まり）から文字を並べる */
function put(cells: Cell[][], row: number, col: number, text: string): void {
  [...text].forEach((ch, i) => (cells[row - 1]![col - 1 + i] = cell(ch)));
}

async function mountPane() {
  const w = mount(EmulatorPane, { props: { sessionId: SID, focused: true }, attachTo: document.body });
  await nextTick();
  return w;
}

/** 欄にフォーカスし、欄内オフセット caret へキャレットを置く */
async function focusAt(w: Awaited<ReturnType<typeof mountPane>>, caret: number) {
  const input = w.find("input.grid-input");
  const el = input.element as HTMLInputElement;
  el.focus();
  el.setSelectionRange(caret, caret);
  await input.trigger("click");
  await nextTick();
  return { input, el };
}

describe("入力欄の中の Ctrl+矢印（頭出し）", () => {
  it("同じ欄の中では前の語頭へキャレットが動き、ブラウザ既定の単語移動は止める", async () => {
    const cells = blank();
    put(cells, 5, 10, "ABC DEF GHI");
    const f: Field = {
      index: 1, row: 5, col: 10, length: 30,
      protected: false, hidden: false, numeric: false, mdt: false, value: "ABC DEF GHI"
    };
    seed([f], cells);
    const w = await mountPane();
    const { input, el } = await focusAt(w, 10); // "GHI" の I の後ろ（桁 20）

    const ev = new KeyboardEvent("keydown", { key: "ArrowLeft", ctrlKey: true, bubbles: true, cancelable: true });
    el.dispatchEvent(ev);
    await nextTick();

    expect(el.selectionStart).toBe(8); // "GHI" の頭（桁 18）
    expect(ev.defaultPrevented).toBe(true); // ペイン keymap が既定の欄内単語移動を潰す
    expect(document.activeElement).toBe(input.element);
    w.unmount();
  });

  it("欄の外の語頭へも飛ぶ（欄は blur されて free モードになる）", async () => {
    const cells = blank();
    put(cells, 5, 2, "XYZ"); // 欄の左（保護領域）にある語
    put(cells, 5, 10, "ABC");
    const f: Field = {
      index: 1, row: 5, col: 10, length: 10,
      protected: false, hidden: false, numeric: false, mdt: false, value: "ABC"
    };
    seed([f], cells);
    const w = await mountPane();
    const { input, el } = await focusAt(w, 0); // 欄の先頭（桁 10）

    el.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", ctrlKey: true, bubbles: true, cancelable: true }));
    await nextTick();

    expect(document.activeElement).not.toBe(input.element); // 欄の外へ出た
    expect(w.find(".cursor").attributes("style")).toContain("1ch"); // 桁 2 = left:1ch
    w.unmount();
  });

  it("DBCS 欄でも同じ欄の中でキャレットが語頭へ動く", async () => {
    // 列ビュー "{あい} {うえ}" を桁 10 から。SO/SI は 1 桁・全角は 2 桁
    const cells = blank();
    const row = cells[4]!;
    row[9] = cell(" ", { kind: "so" });
    row[10] = cell("あ", { kind: "dbcs-lead" });
    row[11] = cell("", { kind: "dbcs-tail" });
    row[12] = cell("い", { kind: "dbcs-lead" });
    row[13] = cell("", { kind: "dbcs-tail" });
    row[14] = cell(" ", { kind: "si" });
    row[16] = cell(" ", { kind: "so" });
    row[17] = cell("う", { kind: "dbcs-lead" });
    row[18] = cell("", { kind: "dbcs-tail" });
    row[19] = cell("え", { kind: "dbcs-lead" });
    row[20] = cell("", { kind: "dbcs-tail" });
    row[21] = cell(" ", { kind: "si" });
    const f: Field = {
      index: 1, row: 5, col: 10, length: 20,
      protected: false, hidden: false, numeric: false, dbcsType: "open", mdt: false, value: ""
    };
    seed([f], cells);
    const w = await mountPane();
    const { el } = await focusAt(w, 8); // 列ビュー末尾側（"え" のうしろ）

    el.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", ctrlKey: true, bubbles: true, cancelable: true }));
    await nextTick();

    // 桁 18 = "う" の先頭。列ビューでは SO(1)+あ(2)+い(2)+SI(1)+空白(1)+SO(1) の次＝index 6
    expect(el.selectionStart).toBe(6);
    w.unmount();
  });

  it("欄に打った未送信の全角も語として見つける（cells はホストの内容しか持たない）", async () => {
    // 画面（cells）は空。欄に "X   あ Y" を打った直後の状態
    const f: Field = {
      index: 1, row: 5, col: 10, length: 20,
      protected: false, hidden: false, numeric: false, dbcsType: "open", mdt: false, value: ""
    };
    seed([f], blank(), new Map([[1, "X   あ Y"]]));
    const w = await mountPane();
    const { el } = await focusAt(w, 0); // 'X' の桁

    el.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", ctrlKey: true, bubbles: true, cancelable: true }));
    await nextTick();

    // 列ビュー "X    あ  Y" の index 5 が 'あ'（Y へ飛び越さない）
    expect(el.value[el.selectionStart ?? -1]).toBe("あ");
    w.unmount();
  });

  it("DBCS の語の中では止まらず、次の語の頭まで飛ぶ", async () => {
    const cells = blank();
    const row = cells[4]!;
    row[9] = cell(" ", { kind: "so" });
    row[10] = cell("あ", { kind: "dbcs-lead" });
    row[11] = cell("", { kind: "dbcs-tail" });
    row[12] = cell("い", { kind: "dbcs-lead" });
    row[13] = cell("", { kind: "dbcs-tail" });
    row[14] = cell(" ", { kind: "si" });
    row[16] = cell(" ", { kind: "so" });
    row[17] = cell("う", { kind: "dbcs-lead" });
    row[18] = cell("", { kind: "dbcs-tail" });
    row[19] = cell("え", { kind: "dbcs-lead" });
    row[20] = cell("", { kind: "dbcs-tail" });
    row[21] = cell(" ", { kind: "si" });
    const f: Field = {
      index: 1, row: 5, col: 10, length: 20,
      protected: false, hidden: false, numeric: false, dbcsType: "open", mdt: false, value: ""
    };
    seed([f], cells);
    const w = await mountPane();
    const { el } = await focusAt(w, 1); // "あい" の頭

    el.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", ctrlKey: true, bubbles: true, cancelable: true }));
    await nextTick();

    // 'い'（語の途中）ではなく次の語 "うえ" の頭へ
    expect(el.value[el.selectionStart ?? -1]).toBe("う");
    w.unmount();
  });
});
