import { describe, it, expect, beforeEach } from "vitest";
import { mount } from "@vue/test-utils";
import { nextTick } from "vue";
import EmulatorPane from "../src/components/EmulatorPane.vue";
import { sessionsStore } from "../src/stores/sessions.js";
import type { ScreenSnapshot, Cell, Field } from "@ts5250/tn5250";
import type { WsClient } from "../src/ws-client.js";

/**
 * **挿入モードは画面ごとに上書きへ戻す**（`20260921-insert-mode-per-screen`）。
 *
 * ACS は `DS5250.initKeyboard`（`resetInsertMode` を呼ぶ）を、書式の開始・WEC・
 * `processClearFMT` から呼ぶので、**新しい画面は必ず上書きモードで始まる**。
 * 当 PJ は利用者の切り替えでしか変わらず、前の画面の挿入モードが残っていた。
 *
 * 残ると「挿入で欄が満杯のとき弾く」規則（`20260920-insert-mode-overflow`）と重なり、
 * 次の画面で**打てない・意図せず押し出す**が起きる。
 */
const SID = "s1";

const cell = (): Cell =>
  ({ char: " ", kind: "sbcs", color: "green", reverse: false, underline: false,
     blink: false, columnSeparator: false, nonDisplay: false }) as Cell;

function snap(tag: string): ScreenSnapshot {
  const cells: Cell[][] = [];
  for (let r = 0; r < 24; r++) {
    const row: Cell[] = [];
    for (let c = 0; c < 80; c++) row.push(cell());
    cells.push(row);
  }
  const fields: Field[] = [
    { index: 1, row: 5, col: 10, length: 8, protected: false, hidden: false,
      numeric: false, mdt: false, value: tag } as Field
  ];
  return { sessionId: SID, rows: 24, cols: 80, cursor: { row: 5, col: 10 },
    keyboardLocked: false, cells, fields } as unknown as ScreenSnapshot;
}

function seed(s: ScreenSnapshot): void {
  sessionsStore.byId.clear();
  sessionsStore.order = [];
  sessionsStore.add({
    sessionId: SID, label: "t", snapshot: s, edits: new Map(), cursor: s.cursor,
    link: { state: "connected" }, resumability: "resumable", readOnly: false,
    client: { send: () => {} } as unknown as WsClient
  });
}

describe("挿入モードは画面をまたいで残らない", () => {
  beforeEach(() => {
    document.body.replaceChildren();
    seed(snap("A"));
  });

  it("新しいホスト画面が来たら上書きモードへ戻る", async () => {
    const w = mount(EmulatorPane, { props: { sessionId: SID, focused: true }, attachTo: document.body });
    await nextTick();
    const grid = w.findComponent({ name: "ScreenGrid" });

    // 利用者が挿入モードにする（ScreenGrid の v-model が親の ref を書き換える）
    grid.vm.$emit("update:insertMode", true);
    await nextTick();
    expect(grid.props("insertMode"), "前提: 挿入モードになっている").toBe(true);

    // **ホストが次の画面を送る**
    seed(snap("B"));
    await nextTick();
    await nextTick();

    expect(
      w.findComponent({ name: "ScreenGrid" }).props("insertMode"),
      "新しい画面は上書きモードで始まる（ACS: initKeyboard → resetInsertMode）"
    ).toBe(false);
    w.unmount();
  });
});
