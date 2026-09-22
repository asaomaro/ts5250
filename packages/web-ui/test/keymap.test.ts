import { describe, it, expect, vi } from "vitest";
import { classifyKey, makeKeydownHandler } from "../src/composables/useKeymap.js";

const base = { shiftKey: false, ctrlKey: false, altKey: false, metaKey: false };

describe("classifyKey", () => {
  it("F1–F12 を AID にマップする", () => {
    expect(classifyKey({ ...base, key: "F1" })).toEqual({ aid: "F1" });
    expect(classifyKey({ ...base, key: "F12" })).toEqual({ aid: "F12" });
  });

  it("Shift+F1–F12 を F13–F24 にマップする", () => {
    expect(classifyKey({ ...base, key: "F1", shiftKey: true })).toEqual({ aid: "F13" });
    expect(classifyKey({ ...base, key: "F12", shiftKey: true })).toEqual({ aid: "F24" });
  });

  /**
   * **Shift+Enter は送信ではなく Newline**（`20260921-shift-enter-newline`）。
   * ACS の既定割り当て `AcsMapFunctions.MAP_5250` が `S10 = [newline]` を持ち、
   * `PS5250.processNewline` はホストへ送らない。以前は Shift を見ずに Enter を送っており、
   * サブファイルの入力中に押すと入力途中のまま送信されていた。
   */
  it("Shift+Enter は Newline（AID を送らない）", () => {
    const r = classifyKey({ ...base, key: "Enter", shiftKey: true });
    expect(r.aid, "Shift+Enter でホストへ送ってはいけない").toBeUndefined();
    expect(r.local).toBe("newline");
  });

  it("Enter / PageUp / PageDown を AID にマップする", () => {
    expect(classifyKey({ ...base, key: "Enter" }).aid).toBe("Enter");
    expect(classifyKey({ ...base, key: "PageUp" }).aid).toBe("PageUp");
    expect(classifyKey({ ...base, key: "PageDown" }).aid).toBe("PageDown");
  });

  it("Home/End/Tab/矢印はローカル操作", () => {
    expect(classifyKey({ ...base, key: "Home" }).local).toBe("home");
    expect(classifyKey({ ...base, key: "Tab" }).local).toBe("tab");
    expect(classifyKey({ ...base, key: "Tab", shiftKey: true }).local).toBe("shift-tab");
    expect(classifyKey({ ...base, key: "ArrowLeft" }).local).toBe("left");
  });

  it("修飾キー付き（Ctrl/Alt/Meta）は対象外", () => {
    expect(classifyKey({ ...base, key: "F5", ctrlKey: true })).toEqual({});
  });

  it("Ctrl+矢印は語頭ジャンプ（上下左右すべてローカル操作）", () => {
    expect(classifyKey({ ...base, key: "ArrowLeft", ctrlKey: true })).toEqual({ local: "word-left" });
    expect(classifyKey({ ...base, key: "ArrowRight", ctrlKey: true })).toEqual({ local: "word-right" });
    expect(classifyKey({ ...base, key: "ArrowUp", ctrlKey: true })).toEqual({ local: "word-up" });
    expect(classifyKey({ ...base, key: "ArrowDown", ctrlKey: true })).toEqual({ local: "word-down" });
  });

  // ~~Alt+←/→ は対象外~~ → ACS の既定 `A37 = [backtabword]`・`A39 = [tabword]`（`20260921-word-tab-acs`）。アプリのショートカットは Alt+Shift 系
  it("**Alt+←/→ は語頭ジャンプ**（ACS の `[backtabword]`・`[tabword]`）。Alt+↑/↓ は別の用途（ドロップダウン）のまま", () => {
    expect(classifyKey({ ...base, key: "ArrowLeft", altKey: true })).toEqual({ local: "word-left" });
    expect(classifyKey({ ...base, key: "ArrowRight", altKey: true })).toEqual({ local: "word-right" });
    expect(classifyKey({ ...base, key: "ArrowUp", altKey: true })).toEqual({});
    expect(classifyKey({ ...base, key: "ArrowDown", altKey: true })).toEqual({});
    // Alt+Shift+矢印はアプリのペイン移動・Ctrl+Alt+矢印は割り当てない
    expect(classifyKey({ ...base, key: "ArrowLeft", altKey: true, shiftKey: true })).toEqual({});
    expect(classifyKey({ ...base, key: "ArrowLeft", altKey: true, ctrlKey: true })).toEqual({});
  });

  it("タブ切替(Alt+PageUp/Down)は App 側担当のため対象外", () => {
    expect(classifyKey({ ...base, key: "PageDown", altKey: true })).toEqual({});
    expect(classifyKey({ ...base, key: "PageUp", altKey: true })).toEqual({});
    // Ctrl+Shift+← は語頭ジャンプにしない（純粋な Ctrl+矢印のみ）
    expect(classifyKey({ ...base, key: "ArrowLeft", ctrlKey: true, shiftKey: true })).toEqual({});
  });

  it("通常文字は対象外（input へ通す）", () => {
    expect(classifyKey({ ...base, key: "a" })).toEqual({});
  });
});

describe("makeKeydownHandler", () => {
  it("フォーカス時のみ AID を送り preventDefault する", () => {
    const sendAid = vi.fn();
    const prevent = vi.fn();
    const h = makeKeydownHandler({ sendAid, local: vi.fn(), viewCycle: vi.fn(), playMacro: vi.fn(), isFocused: () => true });
    h({ key: "F3", shiftKey: false, ctrlKey: false, altKey: false, metaKey: false, preventDefault: prevent } as unknown as KeyboardEvent);
    expect(sendAid).toHaveBeenCalledWith("F3");
    expect(prevent).toHaveBeenCalled();
  });

  it("非フォーカス時は何もしない", () => {
    const sendAid = vi.fn();
    const h = makeKeydownHandler({ sendAid, local: vi.fn(), viewCycle: vi.fn(), playMacro: vi.fn(), isFocused: () => false });
    h({ key: "Enter", shiftKey: false, ctrlKey: false, altKey: false, metaKey: false, preventDefault: vi.fn() } as unknown as KeyboardEvent);
    expect(sendAid).not.toHaveBeenCalled();
  });
});
