import { describe, it, expect, beforeEach } from "vitest";
import { mount } from "@vue/test-utils";
import { nextTick } from "vue";
import EmulatorPane from "../src/components/EmulatorPane.vue";
import { sessionsStore } from "../src/stores/sessions.js";
import { viewSettings, initViewSettings } from "../src/stores/viewSettings.js";
import type { Cell, Field, ScreenSnapshot } from "@ts5250/tn5250";
import type { WsClient } from "../src/ws-client.js";

/**
 * **ペインごと立てて確かめる**（`ScreenGrid` 単体では出ない不具合があるため）。
 *
 * カーソルの調停（`reconcileFocus`）・欄間の移動・キー配線は `EmulatorPane` 側にあり、
 * グリッド単体のテストでは再現しない。実機 E2E だけが捕まえていた「ピッカーを閉じた後、
 * **別の欄へフォーカスが飛ぶ**」をここで速く再現・固定する。
 */

const SID = "dtp-pane";
const TROW = 11;
const COL = 24;

function cell(ch = " "): Cell {
  return { char: ch, kind: "sbcs", color: "green", reverse: false, underline: false,
    blink: false, columnSeparator: false, nonDisplay: false } as Cell;
}
function fld(over: Partial<Field> & { index: number; row: number; col: number; length: number }): Field {
  return { protected: false, hidden: false, numeric: true, mdt: false, value: "", ...over } as Field;
}
/** 行 3 に素の欄、行 11 に時刻の分割欄（実機 DTMDSPF の DMA / TMW と同じ並び） */
const FIELDS: Field[] = [
  fld({ index: 1, row: 3, col: COL, length: 8 }),
  fld({ index: 2, row: TROW, col: COL, length: 2, continued: "first", value: "13" }),
  fld({ index: 3, row: TROW, col: COL + 3, length: 2, continued: "middle", value: "30" }),
  fld({ index: 4, row: TROW, col: COL + 6, length: 2, continued: "last", value: "15" })
];
function snap(): ScreenSnapshot {
  const cells: Cell[][] = [];
  for (let r = 1; r <= 24; r++) {
    const row: Cell[] = [];
    for (let c = 1; c <= 80; c++) row.push(cell());
    cells.push(row);
  }
  cells[TROW - 1]![COL + 1] = cell(":");
  cells[TROW - 1]![COL + 4] = cell(":");
  return { sessionId: SID, rows: 24, cols: 80, cursor: { row: TROW, col: COL },
    keyboardLocked: false, cells, fields: FIELDS } as unknown as ScreenSnapshot;
}

beforeEach(() => {
  localStorage.clear();
  initViewSettings();
  viewSettings.set("dtPicker", "panel");
  sessionsStore.byId.clear();
  sessionsStore.order = [];
  sent.length = 0;
  sessionsStore.add({
    sessionId: SID, label: "t", snapshot: snap(), edits: new Map(), cursor: { row: TROW, col: COL },
    connected: true, readOnly: false,
    client: { send(m: unknown) { sent.push(m); } } as unknown as WsClient
  });
});
/** ホストへ送った内容（AID が漏れていないかを見る） */
const sent: unknown[] = [];

const active = () => document.activeElement as HTMLElement | null;
const press = (key: string, init: KeyboardEventInit = {}) =>
  active()!.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init }));

describe("ピッカーを閉じた後のフォーカス（ペインごと）", () => {
  async function openPicker() {
    const w = mount(EmulatorPane, { props: { sessionId: SID, focused: true }, attachTo: document.body });
    await nextTick();
    const input = w.find(`input.grid-input[data-field-index="2"]`);
    await input.trigger("focus");
    await nextTick();
    // Alt+↓（ペインの既存ハンドラ経由）で開く
    await w.find(".pane").trigger("keydown", { key: "ArrowDown", altKey: true });
    await nextTick();
    await nextTick();
    return w;
  }

  it("`Alt+↓` でピッカーが開き、フォーカスが中へ移る", async () => {
    const w = await openPicker();
    expect(w.find(".dtp").exists()).toBe(true);
    expect(active()?.closest(".dtp")).not.toBeNull();
    w.unmount();
  });

  it("`Enter` で確定して閉じたあと、**編集していた欄**へフォーカスが戻る", async () => {
    const w = await openPicker();
    press("Enter");
    await nextTick();
    await nextTick();
    expect(w.find(".dtp").exists()).toBe(false);
    expect(active()?.getAttribute("data-field-index"), "別の欄へ飛んでいる").toBe("2");
    w.unmount();
  });

  /**
   * **ピッカーの `Enter` をホストへ送ってはいけない。**
   *
   * 伝播を止めないとペインまで上がり、**AID の Enter が飛ぶ**——ピッカーは同期的に閉じるので、
   * ペイン側の「開いている間は無視」の条件が event の届く頃には既に外れている。
   * 実機ではこれで画面が再表示され、**カーソルが先頭の欄へ飛んだ**（E2E だけが捕まえていた）。
   */
  it("`Enter` は確定に使い、ホストへ AID を送らない", async () => {
    const w = await openPicker();
    sent.length = 0;
    press("Enter");
    await nextTick();
    await nextTick();
    const aids = sent.filter((m) => JSON.stringify(m).includes("Enter"));
    expect(aids, "AID の Enter がホストへ漏れている").toEqual([]);
    w.unmount();
  });

  it("`Esc` で閉じたときも同じ欄へ戻る", async () => {
    const w = await openPicker();
    press("Escape");
    await nextTick();
    await nextTick();
    expect(w.find(".dtp").exists()).toBe(false);
    expect(active()?.getAttribute("data-field-index")).toBe("2");
    w.unmount();
  });
});
