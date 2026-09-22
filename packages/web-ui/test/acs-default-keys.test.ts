import { describe, it, expect, beforeEach, vi } from "vitest";
import { mount } from "@vue/test-utils";
import { nextTick } from "vue";
import EmulatorPane from "../src/components/EmulatorPane.vue";
import ScreenGrid from "../src/components/ScreenGrid.vue";
import { sessionsStore } from "../src/stores/sessions.js";
import { keybindingsStore, DEFAULT_BINDINGS, BINDINGS_VERSION } from "../src/stores/keybindings.js";
import { makeKeydownHandler } from "../src/composables/useKeymap.js";
import { DUP_BYTE } from "../src/composables/fieldEdit.js";
import { rawSentinel } from "@ts5250/tn5250/browser";
import type { ScreenSnapshot, Cell, Field } from "@ts5250/tn5250";
import type { WsClient } from "../src/ws-client.js";

/**
 * **ACS の既定のキー割り当て**（`20260921-acs-default-keys`）。
 * 原典は `AcsMapFunctions.MAP_5250`（ACS では `DefaultKeyboardRemap.getMapFile` がこの表を使う）。
 * `B27 = [attn]`・`S27 = [sysreq]`・`A35 = [erinp]`・`S155 = [dup]`・`B19 = [clear]`・`C19 = [printhost]`・
 * `A112 = [help]`・`C112 = [dspsosi]`・`C114 = [altview]`。`B35 = [eof]` は Erase EOF ではなく欄の末尾へ移る
 * （`PS5250.processEndField`）ので、End には何も割り当てない。
 */

const SID = "adk1";
function cells(): Cell[][] {
  return Array.from({ length: 24 }, () =>
    Array.from({ length: 80 }, () => ({ char: " ", kind: "sbcs", color: "green", reverse: false, underline: false, blink: false, columnSeparator: false, nonDisplay: false }) as Cell)
  );
}
function field(over: Partial<Field> = {}): Field {
  return { index: 1, row: 20, col: 8, length: 6, protected: false, hidden: false, numeric: false, mdt: false, value: "", ...over };
}
let sent: { type: string; key?: string }[] = [];
function seed(fields: Field[]): void {
  sessionsStore.byId.clear();
  sessionsStore.order = [];
  const snap: ScreenSnapshot = { sessionId: SID, rows: 24, cols: 80, cursor: { row: 20, col: 8 }, keyboardLocked: false, cells: cells(), fields };
  sessionsStore.add({
    sessionId: SID, label: "t", snapshot: snap, edits: new Map(), cursor: { row: 20, col: 8 },
    link: { state: "connected" }, resumability: "resumable", readOnly: false,
    client: { send: (m: { type: string; key?: string }) => { if (m.type !== "activity") sent.push(m); } } as unknown as WsClient
  });
}
const sentKeys = () => sent.filter((m) => m.type === "key").map((m) => m.key);

beforeEach(() => {
  localStorage.clear();
  keybindingsStore.reload(); // 初回起動相当（既定が入る）
  sent = [];
  document.body.replaceChildren();
});

describe("既定の割り当ての中身", () => {
  it("ACS の既定と同じキーに同じ操作が入る", () => {
    expect(DEFAULT_BINDINGS).toMatchObject({
      Escape: "Attn",
      "shift+Escape": "SysReq",
      "alt+End": "local:erase-input",
      "shift+Insert": "local:dup",
      Pause: "Clear",
      "ctrl+Pause": "Print",
      "alt+F1": "Help",
      "ctrl+F1": "view:sosi",
      "ctrl+F3": "view:kana"
    });
  });

  it("**End には割り当てない**（ACS の End は欄の末尾へ移る。Erase EOF ではない）", () => {
    expect(DEFAULT_BINDINGS["End"]).toBeUndefined();
    expect(keybindingsStore.resolve({ key: "End", ctrlKey: false, shiftKey: false, altKey: false })).toBeUndefined();
  });
});

describe("キーハンドラー", () => {
  function handler() {
    const h = { sendAid: vi.fn(), local: vi.fn(), viewCycle: vi.fn(), playMacro: vi.fn(), isFocused: () => true };
    return { h, run: makeKeydownHandler(h) };
  }
  const ev = (over: Partial<KeyboardEvent>) =>
    ({ key: "", shiftKey: false, ctrlKey: false, altKey: false, metaKey: false, isComposing: false, preventDefault: vi.fn(), ...over }) as unknown as KeyboardEvent;

  it("Esc は Attn・Shift+Esc は SysReq・Pause は Clear・Ctrl+Pause は Print・Alt+F1 は Help を送る", () => {
    const { h, run } = handler();
    run(ev({ key: "Escape" }));
    run(ev({ key: "Escape", shiftKey: true }));
    run(ev({ key: "Pause" }));
    run(ev({ key: "Pause", ctrlKey: true }));
    run(ev({ key: "Cancel", ctrlKey: true }));
    run(ev({ key: "F1", altKey: true }));
    expect(h.sendAid.mock.calls.map((c) => c[0])).toEqual(["Attn", "SysReq", "Clear", "Print", "Print", "Help"]);
  });

  it("Alt+End は Erase Input、Shift+Insert は Dup（どちらもホストへ送らない）", () => {
    const { h, run } = handler();
    run(ev({ key: "End", altKey: true }));
    run(ev({ key: "Insert", shiftKey: true }));
    expect(h.local.mock.calls.map((c) => c[0])).toEqual(["erase-input", "dup"]);
    expect(h.sendAid).not.toHaveBeenCalled();
  });

  it("**IME の変換中の Esc は Attn にしない**（変換の取り消しに使うキー）", () => {
    const { h, run } = handler();
    run(ev({ key: "Escape", isComposing: true }));
    run(ev({ key: "Process" }));
    run(ev({ key: "Escape", keyCode: 229 })); // Safari の確定・取り消しの後の Esc
    expect(h.sendAid).not.toHaveBeenCalled();
    expect(h.local).not.toHaveBeenCalled();
  });
});

describe("欄の中で押したとき（ペイン結合）", () => {
  const mountPane = () => mount(EmulatorPane, { props: { sessionId: SID, focused: true }, attachTo: document.body });
  const input = () => document.querySelector("input.grid-input:not([readonly])") as HTMLInputElement;
  const key = async (over: KeyboardEventInit) => {
    input().dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...over }));
    await nextTick();
  };

  it("Shift+Insert は挿入モードを切り替えず Dup になる", async () => {
    seed([field({ dupEnable: true })]);
    const w = mountPane();
    await nextTick();
    input().focus();
    input().setSelectionRange(0, 0);
    await key({ key: "Insert", shiftKey: true });
    expect(sessionsStore.byId.get(SID)!.edits.get(1)).toBe(rawSentinel(DUP_BYTE).repeat(6));
    expect(w.find(".mode").text()).toBe("上書き"); // 挿入モードに切り替わっていない
    w.unmount();
  });

  it("Insert（修飾なし）は従来どおり挿入モードの切り替え", async () => {
    seed([field({ value: "ABC" })]);
    const w = mountPane();
    await nextTick();
    input().focus();
    input().setSelectionRange(0, 0);
    await key({ key: "Insert" });
    expect(w.find(".mode").text()).toBe("挿入");
    await key({ key: "X" });
    expect(sessionsStore.byId.get(SID)!.edits.get(1)).toBe("XABC");
    w.unmount();
  });

  it("End（割り当て無し）は欄の末尾へ。利用者が Erase EOF を割り当てればそれが効く", async () => {
    seed([field({ value: "ABCD" })]);
    const w = mountPane();
    await nextTick();
    input().focus();
    input().setSelectionRange(1, 1);
    await key({ key: "End" });
    await key({ key: "X" });
    expect(sessionsStore.byId.get(SID)!.edits.get(1)).toBe("ABCDX");
    keybindingsStore.set("End", "local:erase-eof");
    input().setSelectionRange(1, 1);
    await key({ key: "ArrowLeft" }); // 編集カーソルを native caret から取り直させる
    await key({ key: "ArrowRight" });
    await key({ key: "End" });
    expect(sessionsStore.byId.get(SID)!.edits.get(1)).toBe("A");
    w.unmount();
  });

  it("欄の中の Esc は Attn を送る", async () => {
    seed([field()]);
    const w = mountPane();
    await nextTick();
    input().focus();
    await key({ key: "Escape" });
    expect(sentKeys()).toEqual(["Attn"]);
    w.unmount();
  });
});

describe("保存済みの割り当てへの反映（版 4）", () => {
  const load = (saved: Record<string, string>, version: number) => {
    localStorage.clear();
    localStorage.setItem("as400.keybindings", JSON.stringify(saved));
    localStorage.setItem("as400.keybindings.version", String(version));
    keybindingsStore.reload();
    return keybindingsStore.bindings as Record<string, string>;
  };

  it("古い既定の組（Ctrl+F1=表示コード・Ctrl+F3=SO/SI）のままなら ACS の向きへ直す", () => {
    const b = load({ "ctrl+F1": "view:kana", "ctrl+F3": "view:sosi" }, 3);
    expect(b["ctrl+F1"]).toBe("view:sosi");
    expect(b["ctrl+F3"]).toBe("view:kana");
    expect(b["Escape"]).toBe("Attn"); // 版 4 の追加分も入る
  });

  it("**片方でも変えていれば直さない**（利用者の意図を壊さない）", () => {
    expect(load({ "ctrl+F1": "F5", "ctrl+F3": "view:sosi" }, 3)).toMatchObject({ "ctrl+F1": "F5", "ctrl+F3": "view:sosi" });
    const removed = load({ "ctrl+F3": "view:sosi" }, 3);
    expect(removed["ctrl+F1"]).toBeUndefined();
    expect(removed["ctrl+F3"]).toBe("view:sosi");
  });

  it("Esc を別用途に割り当てていれば奪わない", () => {
    expect(load({ Escape: "F3" }, 3)["Escape"]).toBe("F3");
  });

  it("版 4 で保存した値は直さない（直すのは版 4 より前の保存値だけ）", () => {
    const b = load({ "ctrl+F1": "view:kana", "ctrl+F3": "view:sosi" }, Math.max(4, BINDINGS_VERSION));
    expect(b["ctrl+F1"]).toBe("view:kana");
  });
});

describe("DBCS 欄でも同じ（欄の input が自分で処理するキーの委譲）", () => {
  const dbcs: Field = { index: 1, row: 2, col: 3, length: 20, protected: false, hidden: false, numeric: false, dbcsType: "open", mdt: false, value: "" };
  function mountGrid() {
    const snap: ScreenSnapshot = { sessionId: "g", rows: 24, cols: 80, cursor: { row: 2, col: 3 }, keyboardLocked: false, cells: cells(), fields: [dbcs] };
    return mount(ScreenGrid, { props: { snapshot: snap, edits: new Map([[1, "あい"]]), focused: true }, attachTo: document.body });
  }
  const keydown = (el: HTMLInputElement, over: KeyboardEventInit) => {
    const e = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...over });
    el.dispatchEvent(e);
    return e;
  };

  it("Shift+Insert は挿入モードを切り替えず、ペインのキーマップへ渡す", async () => {
    const w = mountGrid();
    const el = w.find("input.grid-input").element as HTMLInputElement;
    await w.find("input.grid-input").trigger("focus");
    const e = keydown(el, { key: "Insert", shiftKey: true });
    expect(w.emitted("update:insertMode")).toBeUndefined();
    expect(e.defaultPrevented).toBe(false); // 欄は処理していない（ペインが Dup にする）
    keydown(el, { key: "Insert" }); // 割り当ての無い Insert は切り替える
    expect(w.emitted("update:insertMode")).toEqual([[true]]);
    w.unmount();
  });

  it("End は割り当てが無ければ欄の中で末尾へ、割り当てがあればペインへ渡す", async () => {
    const w = mountGrid();
    const el = w.find("input.grid-input").element as HTMLInputElement;
    await w.find("input.grid-input").trigger("focus");
    el.setSelectionRange(0, 0);
    expect(keydown(el, { key: "End" }).defaultPrevented).toBe(true);
    keybindingsStore.set("End", "local:erase-eof");
    expect(keydown(el, { key: "End" }).defaultPrevented).toBe(false);
    w.unmount();
  });
});
