import { describe, it, expect, beforeEach } from "vitest";
import { mount } from "@vue/test-utils";
import { nextTick } from "vue";
import EmulatorPane from "../src/components/EmulatorPane.vue";
import { sessionsStore } from "../src/stores/sessions.js";
import type { ScreenSnapshot, Cell, GuiWindow } from "@as400web/core";
import type { WsClient } from "../src/ws-client.js";

/**
 * **カーソルキーの移動範囲**。
 *
 * - 窓の中に居るときは窓から出ない。右端の → は次の行の頭、最下行の ↓ は同じ桁の最上行。
 * - 窓の外に居るときは画面全体（＝窓の外から矢印で入ってこられる）。
 * - 通常画面でも最下行の ↓ は最上行へ回り込む（5250 端末の挙動）。
 * - **Shift+矢印の矩形選択は影響を受けない**（回り込むと選択が画面全体に化ける）。
 *
 * 窓の中身の範囲は実機で確定している。ホストが送る位置は枠の左上で、中身はその
 * 1 行下・3 桁右から（実機 GRIDCL5: SBA(8,24) 深さ 8 幅 30 → 行 9〜16・桁 27〜56）。
 */
const SID = "s1";

function cell(): Cell {
  return {
    char: " ", kind: "sbcs", color: "green",
    reverse: false, underline: false, blink: false, columnSeparator: false, nonDisplay: false
  };
}

function snap(windows: GuiWindow[] = []): ScreenSnapshot {
  const cells: Cell[][] = [];
  for (let r = 0; r < 24; r++) {
    const row: Cell[] = [];
    for (let c = 0; c < 80; c++) row.push(cell());
    cells.push(row);
  }
  return {
    sessionId: SID, rows: 24, cols: 80, cursor: { row: 1, col: 1 },
    keyboardLocked: false, cells, fields: [],
    ...(windows.length > 0
      ? { gui: { selectionFields: [], windows, scrollBars: [], gridLines: [] } }
      : {})
  } as ScreenSnapshot;
}

/** 実機 GRIDCL5 の窓。中身は 行 9〜16・桁 27〜56 */
const WIN: GuiWindow = {
  id: 1, row: 8, col: 24, width: 30, height: 8, restrictCursor: true, pulldown: false
};

function seed(windows: GuiWindow[] = []): void {
  sessionsStore.byId.clear();
  sessionsStore.order = [];
  sessionsStore.add({
    sessionId: SID, label: "t", snapshot: snap(windows), edits: new Map(),
    cursor: { row: 1, col: 1 }, connected: true, readOnly: false, client: { send: () => {} } as unknown as WsClient
  });
}

function mountPane(): ReturnType<typeof mount> {
  return mount(EmulatorPane, { props: { sessionId: SID, focused: true }, attachTo: document.body });
}

/** 状態表示（`行/桁`）から今のカーソル位置を読む */
function cursorOf(w: ReturnType<typeof mount>): string {
  return /(\d+)\/(\d+)/.exec(w.find(".pane").element.parentElement?.textContent ?? "")?.[0] ?? "";
}

async function press(w: ReturnType<typeof mount>, key: string, extra: Record<string, unknown> = {}): Promise<void> {
  await w.find(".pane").trigger("keydown", { key, ...extra });
  await nextTick();
}

/** カーソルを狙った桁へ運ぶ（クリック相当。ScreenGrid の cursor イベントを使う） */
async function placeCursor(w: ReturnType<typeof mount>, row: number, col: number): Promise<void> {
  await w.findComponent({ name: "ScreenGrid" }).vm.$emit("cursor", row, col);
  await nextTick();
}

describe("カーソルキーの移動範囲", () => {
  beforeEach(() => seed());

  it("通常画面: 最下行の ↓ は最上行へ回り込む", async () => {
    const w = mountPane();
    await nextTick();
    await placeCursor(w, 24, 10);
    await press(w, "ArrowDown");
    expect(cursorOf(w)).toBe("01/010");
    w.unmount();
  });

  it("通常画面: 最上行の ↑ は最下行へ回り込む", async () => {
    const w = mountPane();
    await nextTick();
    await placeCursor(w, 1, 10);
    await press(w, "ArrowUp");
    expect(cursorOf(w)).toBe("24/010");
    w.unmount();
  });

  describe("窓があるとき", () => {
    beforeEach(() => seed([WIN]));

    it("窓の右端の → は次の行の頭へ", async () => {
      const w = mountPane();
      await nextTick();
      await placeCursor(w, 12, 56);
      await press(w, "ArrowRight");
      expect(cursorOf(w)).toBe("13/027");
      w.unmount();
    });

    it("窓の最下行の ↓ は同じ桁の最上行へ", async () => {
      const w = mountPane();
      await nextTick();
      await placeCursor(w, 16, 40);
      await press(w, "ArrowDown");
      expect(cursorOf(w)).toBe("09/040");
      w.unmount();
    });

    it("窓の左端の ← は前の行の末尾へ", async () => {
      const w = mountPane();
      await nextTick();
      await placeCursor(w, 12, 27);
      await press(w, "ArrowLeft");
      expect(cursorOf(w)).toBe("11/056");
      w.unmount();
    });

    it("窓の外に居るときは画面全体を動ける（窓へ入ってこられる）", async () => {
      const w = mountPane();
      await nextTick();
      await placeCursor(w, 8, 40); // 窓の枠の行＝中身の外
      await press(w, "ArrowDown");
      expect(cursorOf(w)).toBe("09/040"); // 窓の中へ入る
      w.unmount();
    });

    it("窓の外なら通常画面と同じに回り込む", async () => {
      const w = mountPane();
      await nextTick();
      await placeCursor(w, 24, 10); // 窓の外
      await press(w, "ArrowDown");
      expect(cursorOf(w)).toBe("01/010");
      w.unmount();
    });

    /**
     * ホストが「カーソルを窓に閉じ込める」と言っていない窓（flag1 bit0x80 が立たない）は
     * 閉じ込めない。閉じ込めるかどうかはホストの宣言に従う。
     */
    it("restrictCursor が無い窓では閉じ込めない", async () => {
      seed([{ ...WIN, restrictCursor: false }]);
      const w = mountPane();
      await nextTick();
      await placeCursor(w, 16, 40);
      await press(w, "ArrowDown");
      expect(cursorOf(w)).toBe("17/040"); // 窓の外へ出る
      w.unmount();
    });

    /**
     * **矩形選択は別経路**。Shift+矢印は選択の端を伸ばすだけで、
     * 窓に閉じ込めたり回り込ませたりしない（回り込むと選択が画面全体に化ける）。
     */
    it("Shift+矢印の矩形選択はカーソルを動かさない", async () => {
      const w = mountPane();
      await nextTick();
      await placeCursor(w, 16, 40);
      await press(w, "ArrowDown", { shiftKey: true });
      expect(cursorOf(w)).toBe("16/040"); // カーソルは始点に留まる
      w.unmount();
    });
  });
});
