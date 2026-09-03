import { describe, it, expect, beforeEach } from "vitest";
import { mount } from "@vue/test-utils";
import { nextTick } from "vue";
import ScreenGrid from "../src/components/ScreenGrid.vue";
import type { Cell, Field, ScreenSnapshot } from "@ts5250/tn5250";

/**
 * **ホストが施錠している間は打てない**（`keyboardLocked`）。
 *
 * これまで入力プロテクトは `busy`（この画面が出した往復の在庫）だけを見ていた。
 * 時間の掛かる CALL では、ホストが施錠したまま画面を 1 枚書いてきた時点で `busy` が解け、
 * **打てるのに Enter が効かない**（core の `assertReady` が `KEYBOARD_LOCKED` を投げる）
 * 状態になっていた。3270 は応答を待たない設計なので、施錠を見ないとそもそも守りが無い。
 */

const COLS = 80;

function cell(char = " "): Cell {
  return { char, kind: "sbcs", color: "green", reverse: false, underline: false,
    blink: false, columnSeparator: false, nonDisplay: false } as Cell;
}
function snapOf(keyboardLocked: boolean): ScreenSnapshot {
  const cells: Cell[][] = [];
  for (let r = 1; r <= 24; r++) {
    const row: Cell[] = [];
    for (let c = 1; c <= COLS; c++) row.push(cell());
    cells.push(row);
  }
  const fields: Field[] = [
    { index: 1, row: 5, col: 10, length: 6, protected: false, hidden: false,
      numeric: false, mdt: false, value: "" } as Field
  ];
  return { sessionId: "s", rows: 24, cols: COLS, cursor: { row: 5, col: 10 },
    keyboardLocked, cells, fields } as unknown as ScreenSnapshot;
}

describe("ScreenGrid: ホスト施錠中の入力プロテクト", () => {
  beforeEach(() => document.body.replaceChildren());

  function mountGrid(keyboardLocked: boolean) {
    return mount(ScreenGrid, {
      props: {
        snapshot: snapOf(keyboardLocked),
        edits: new Map(),
        focused: true,
        busy: false, // **busy は立っていない**——見るべきは施錠のほうだけ
        cursor: { row: 5, col: 10 }
      },
      attachTo: document.body
    });
  }
  const firstInput = (w: ReturnType<typeof mountGrid>) =>
    w.element.querySelector("input.grid-input:not([readonly])") as HTMLInputElement;

  async function type(w: ReturnType<typeof mountGrid>, text: string) {
    const el = firstInput(w);
    expect(el).toBeTruthy();
    // 施錠中は自動フォーカスが走らない（`focusCursorField` が施錠を見ている）ので、
    // **利用者が欄をクリックした状態**を作ってから打つ。ここを作らないと、
    // キャレットが欄末尾のままで打鍵が落ち、プロテクトの有無に関わらず何も起きない
    el.focus();
    el.setSelectionRange(0, 0);
    for (const ch of text) {
      el.dispatchEvent(new KeyboardEvent("keydown", { key: ch, bubbles: true, cancelable: true }));
      await nextTick();
    }
  }

  it("施錠中は打鍵を受け付けない（busy が false でも）", async () => {
    const w = mountGrid(true);
    await nextTick();
    await type(w, "123");
    expect(w.emitted("edit")).toBeUndefined();
  });

  it("施錠が解ければ従来どおり打てる", async () => {
    const w = mountGrid(false);
    await nextTick();
    await type(w, "123");
    const e = w.emitted("edit") as unknown[][];
    expect(e[e.length - 1]![1]).toBe("123");
  });

  it("施錠中はペーストも受け付けない", async () => {
    const w = mountGrid(true);
    await nextTick();
    const el = firstInput(w);
    el.focus();
    el.setSelectionRange(0, 0); // 打鍵と同じ理由（上の `type` の注記）
    const input = w.find("input.grid-input:not([readonly])");
    await input.trigger("paste", { clipboardData: { getData: () => "ABC" } });
    expect(w.emitted("edit")).toBeUndefined();
  });
});
