import { describe, it, expect, beforeEach } from "vitest";
import { keybindingsStore, comboOf, DEFAULT_BINDINGS } from "../src/stores/keybindings.js";
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
    const h = makeKeydownHandler({ sendAid, local: vi.fn(), viewCycle: vi.fn(), isFocused: () => true });
    h({ key: "j", ctrlKey: true, shiftKey: false, altKey: false, metaKey: false, preventDefault: vi.fn() } as unknown as KeyboardEvent);
    expect(sendAid).toHaveBeenCalledWith("F4");
  });
});

describe("既定バインド（初期値）", () => {
  it("初回は Ctrl+F1=カナ英・Ctrl+F3=SO/SI が設定済み", () => {
    localStorage.clear();
    keybindingsStore.reload(); // 保存値なし = 初回起動
    expect(keybindingsStore.bindings["ctrl+F1"]).toBe("view:kana");
    expect(keybindingsStore.bindings["ctrl+F3"]).toBe("view:sosi");
  });

  it("Ctrl+F1 / Ctrl+F3 のコンボ表記が実際のキーイベントと一致する", () => {
    // 既定バインドが解決できなければ意味がないので、comboOf の生成と突き合わせる
    expect(comboOf({ key: "F1", ctrlKey: true, shiftKey: false, altKey: false })).toBe("ctrl+F1");
    expect(comboOf({ key: "F3", ctrlKey: true, shiftKey: false, altKey: false })).toBe("ctrl+F3");
    keybindingsStore.reset();
    expect(keybindingsStore.resolve({ key: "F1", ctrlKey: true, shiftKey: false, altKey: false })).toBe("view:kana");
    expect(keybindingsStore.resolve({ key: "F3", ctrlKey: true, shiftKey: false, altKey: false })).toBe("view:sosi");
  });

  it("リセットすると初期値へ戻る（空にならない）", () => {
    keybindingsStore.reset();
    keybindingsStore.remove("ctrl+F1");
    keybindingsStore.set("ctrl+9", "F9");
    keybindingsStore.reset();
    expect(keybindingsStore.bindings).toEqual(DEFAULT_BINDINGS);
  });

  it("既定を削除したら次回起動で復活しない", () => {
    localStorage.clear();
    keybindingsStore.reset(); // 初期状態を保存
    keybindingsStore.remove("ctrl+F1");
    keybindingsStore.reload(); // 次回起動相当
    expect(keybindingsStore.bindings["ctrl+F1"]).toBeUndefined(); // 消えたまま
    expect(keybindingsStore.bindings["ctrl+F3"]).toBe("view:sosi");
  });

  it("既定バインド導入前の保存値には一度だけ混ぜる（既存の割り当ては奪わない）", () => {
    localStorage.clear();
    localStorage.setItem("as400.keybindings", JSON.stringify({ "ctrl+F1": "F5", "ctrl+j": "F4" }));
    keybindingsStore.reload();
    expect(keybindingsStore.bindings["ctrl+F1"]).toBe("F5"); // 使用中のキーは保存値が優先
    expect(keybindingsStore.bindings["ctrl+F3"]).toBe("view:sosi"); // 空いている方は既定が入る
    expect(keybindingsStore.bindings["ctrl+j"]).toBe("F4");
  });
});
