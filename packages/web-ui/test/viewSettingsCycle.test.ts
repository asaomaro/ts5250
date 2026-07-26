import { describe, it, expect, vi, beforeEach } from "vitest";
import { viewSettings, VIEW_ITEMS, initViewSettings } from "../src/stores/viewSettings.js";
import { keybindingsStore } from "../src/stores/keybindings.js";
import { makeKeydownHandler } from "../src/composables/useKeymap.js";

const base = { shiftKey: false, ctrlKey: false, altKey: false, metaKey: false, preventDefault() {} };

beforeEach(() => {
  localStorage.clear();
  initViewSettings(); // 保存値をクリアして初期値へ
  keybindingsStore.reset();
});

describe("viewSettings.cycle", () => {
  it("2 値の項目は押すたびに切り替わり、末尾で先頭へ戻る", () => {
    expect(viewSettings.settings.surface).toBe("flat"); // 初期値
    expect(viewSettings.cycle("surface")).toEqual({ label: "画面の質感", valueLabel: "CRT" });
    expect(viewSettings.settings.surface).toBe("crt");
    expect(viewSettings.cycle("surface")).toEqual({ label: "画面の質感", valueLabel: "フラット" });
    expect(viewSettings.settings.surface).toBe("flat");
  });

  it("3 値以上の項目も順送りで一巡する", () => {
    // plain から順送りして一巡する（選択肢はデザイン候補ぶん増えている）
    const order = ["underline", "filled", "box", "boxRound", "inset", "dashed", "glow", "plain"];
    for (const expected of order) {
      viewSettings.cycle("controls");
      expect(viewSettings.settings.controls).toBe(expected);
    }
  });

  it("順送りした値は保存される（再読み込み後も維持）", () => {
    viewSettings.cycle("colorMode"); // literal → semantic
    initViewSettings(); // 保存値から読み直す＝再読み込み相当
    expect(viewSettings.settings.colorMode).toBe("semantic");
  });

  it("font は順送りの対象に含めない（選択肢が環境依存のため）", () => {
    expect(VIEW_ITEMS.some((i) => (i.key as string) === "font")).toBe(false);
    expect(viewSettings.cycle("font")).toBeUndefined();
  });

  it("不明なキーは何もしない", () => {
    expect(viewSettings.cycle("nope")).toBeUndefined();
  });
});

describe("キーバインドからの表示設定切り替え", () => {
  it("view:* を割り当てたキーは AID を送らず順送りする", () => {
    keybindingsStore.set("ctrl+1", "view:surface");
    const sendAid = vi.fn();
    const viewCycle = vi.fn();
    const handler = makeKeydownHandler({ sendAid, local: vi.fn(), viewCycle, isFocused: () => true });

    handler({ ...base, key: "1", ctrlKey: true } as unknown as KeyboardEvent);

    expect(viewCycle).toHaveBeenCalledWith("surface");
    expect(sendAid).not.toHaveBeenCalled();
  });

  it("AID を割り当てたキーは従来どおりホストへ送る", () => {
    keybindingsStore.set("ctrl+2", "F5");
    const sendAid = vi.fn();
    const viewCycle = vi.fn();
    const handler = makeKeydownHandler({ sendAid, local: vi.fn(), viewCycle, isFocused: () => true });

    handler({ ...base, key: "2", ctrlKey: true } as unknown as KeyboardEvent);

    expect(sendAid).toHaveBeenCalledWith("F5");
    expect(viewCycle).not.toHaveBeenCalled();
  });
});
