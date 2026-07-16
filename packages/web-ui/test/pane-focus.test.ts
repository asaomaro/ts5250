import { describe, it, expect, beforeEach } from "vitest";
import { mount } from "@vue/test-utils";
import { nextTick } from "vue";
import EmulatorPane from "../src/components/EmulatorPane.vue";
import { sessionsStore } from "../src/stores/sessions.js";
import type { ScreenSnapshot, Cell, Field } from "@as400web/core";
import type { WsClient } from "../src/ws-client.js";

function cells(): Cell[][] {
  const out: Cell[][] = [];
  for (let r = 0; r < 24; r++) {
    const row: Cell[] = [];
    for (let c = 0; c < 80; c++) {
      row.push({ char: " ", kind: "sbcs", color: "green", reverse: false, underline: false, blink: false, columnSeparator: false, nonDisplay: false });
    }
    out.push(row);
  }
  return out;
}

function cmdField(value = ""): Field {
  return { index: 1, row: 20, col: 8, length: 60, protected: false, hidden: false, numeric: false, mdt: false, value };
}

function snap(field: Field, cursor = { row: 20, col: 8 }): ScreenSnapshot {
  return { sessionId: SID, rows: 24, cols: 80, cursor, keyboardLocked: false, cells: cells(), fields: [field] };
}

const SID = "f1";

function seed(s: ScreenSnapshot): void {
  sessionsStore.byId.clear();
  sessionsStore.order = [];
  sessionsStore.add({
    sessionId: SID,
    label: "t",
    snapshot: s,
    edits: new Map(),
    cursor: s.cursor,
    connected: true,
    readOnly: false,
    client: { send() {} } as unknown as WsClient
  });
}

function mountPane() {
  return mount(EmulatorPane, { props: { sessionId: SID, focused: true }, attachTo: document.body });
}

describe("EmulatorPane 画面遷移後のフォーカス・編集リセット", () => {
  beforeEach(() => seed(snap(cmdField())));

  it("画面遷移でカーソル位置の入力欄へ自動フォーカスする", async () => {
    const w = mountPane();
    await nextTick();
    const input = w.find("input.grid-input").element as HTMLInputElement;
    expect(document.activeElement).toBe(input); // 初期表示でフォーカス

    // 別画面へ遷移（新 snapshot・edits はクリアされる）
    sessionsStore.updateScreen(SID, snap(cmdField()));
    await nextTick();
    await nextTick();
    expect(document.activeElement).toBe(w.find("input.grid-input").element);
    w.unmount();
  });

  it("入力欄が無い画面へ遷移するとペインへフォーカスする（自由カーソル・F キーが効く）", async () => {
    const w = mountPane();
    await nextTick(); // 初期はコマンド欄へフォーカス
    // 入力欄が 1 つも無い画面へ遷移
    const noField: ScreenSnapshot = { sessionId: SID, rows: 24, cols: 80, cursor: { row: 1, col: 1 }, keyboardLocked: false, cells: cells(), fields: [] };
    sessionsStore.updateScreen(SID, noField);
    await nextTick();
    await nextTick();
    // 見た目だけでなく実際にペインが focus され、キーボード操作できる状態になる
    expect(document.activeElement).toBe(w.find(".pane").element);
    w.unmount();
  });

  it("同じ field index の別画面で直前のコマンドが残らない", async () => {
    const w = mountPane();
    await nextTick();
    const input = () => w.find("input.grid-input");

    // 1 画面目でコマンド入力
    await input().trigger("keydown", { key: "A" });
    await input().trigger("keydown", { key: "B" });
    expect(sessionsStore.get(SID)!.edits.get(1)).toBe("AB");

    // 遷移（同じ index=1 のコマンド欄・空）
    sessionsStore.updateScreen(SID, snap(cmdField()));
    await nextTick();
    await nextTick();
    expect(sessionsStore.get(SID)!.edits.get(1)).toBeUndefined(); // クリア済み

    // 遷移後に入力 → 直前の "AB" が残らず "X" のみ
    await input().trigger("keydown", { key: "X" });
    expect(sessionsStore.get(SID)!.edits.get(1)).toBe("X");
    w.unmount();
  });

  it("キーボードロック中の画面更新では自動フォーカスしない", async () => {
    const w = mountPane();
    await nextTick();
    (document.activeElement as HTMLElement).blur();

    const locked = snap(cmdField());
    locked.keyboardLocked = true;
    sessionsStore.updateScreen(SID, locked);
    await nextTick();
    await nextTick();
    expect(document.activeElement).not.toBe(w.find("input.grid-input").element);
    w.unmount();
  });
});
