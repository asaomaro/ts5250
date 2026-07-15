import { describe, it, expect, beforeEach } from "vitest";
import { keybindingsStore, comboOf } from "../src/stores/keybindings.js";
import { makeKeydownHandler } from "../src/composables/useKeymap.js";
import { vi } from "vitest";

beforeEach(() => {
  keybindingsStore.reset();
  if (typeof localStorage !== "undefined") localStorage.clear();
});

describe("comboOf", () => {
  it("修飾キー付きコンボを正規化する", () => {
    expect(comboOf({ key: "3", ctrlKey: true, shiftKey: false, altKey: false })).toBe("ctrl+3");
    expect(comboOf({ key: "F1", ctrlKey: false, shiftKey: true, altKey: false })).toBe("shift+F1");
    expect(comboOf({ key: "Enter", ctrlKey: false, shiftKey: false, altKey: false })).toBe("Enter");
  });
});

describe("keybindingsStore", () => {
  it("カスタムバインドを保存・解決・削除できる", () => {
    keybindingsStore.set("ctrl+3", "F3");
    expect(keybindingsStore.resolve({ key: "3", ctrlKey: true, shiftKey: false, altKey: false })).toBe("F3");
    keybindingsStore.remove("ctrl+3");
    expect(keybindingsStore.resolve({ key: "3", ctrlKey: true, shiftKey: false, altKey: false })).toBeUndefined();
  });
});

describe("useKeymap — カスタムバインド優先", () => {
  it("カスタムバインドが既定より優先して AID を送る", () => {
    keybindingsStore.set("ctrl+j", "F4");
    const sendAid = vi.fn();
    const h = makeKeydownHandler({ sendAid, local: vi.fn(), isFocused: () => true });
    h({ key: "j", ctrlKey: true, shiftKey: false, altKey: false, metaKey: false, preventDefault: vi.fn() } as unknown as KeyboardEvent);
    expect(sendAid).toHaveBeenCalledWith("F4");
  });
});
