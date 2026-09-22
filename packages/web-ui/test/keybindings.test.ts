import { describe, it, expect, beforeEach } from "vitest";
import {
  keybindingsStore,
  comboOf,
  DEFAULT_BINDINGS,
  isLocalBinding,
  isViewBinding,
  localActionOf, BINDINGS_VERSION, latestBindingsVersion } from "../src/stores/keybindings.js";
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
    const h = makeKeydownHandler({ sendAid, local: vi.fn(), viewCycle: vi.fn(), playMacro: vi.fn(), isFocused: () => true });
    h({ key: "j", ctrlKey: true, shiftKey: false, altKey: false, metaKey: false, preventDefault: vi.fn() } as unknown as KeyboardEvent);
    expect(sendAid).toHaveBeenCalledWith("F4");
  });
});

describe("既定バインド（初期値）", () => {
  // ~~Ctrl+F1=カナ英・Ctrl+F3=SO/SI~~ → ACS と同じ向き（`20260921-acs-default-keys`）
  it("初回は Ctrl+F1=SO/SI・Ctrl+F3=表示コードが設定済み", () => {
    localStorage.clear();
    keybindingsStore.reload(); // 保存値なし = 初回起動
    expect(keybindingsStore.bindings["ctrl+F1"]).toBe("view:sosi");
    expect(keybindingsStore.bindings["ctrl+F3"]).toBe("view:kana");
  });

  it("Ctrl+F1 / Ctrl+F3 のコンボ表記が実際のキーイベントと一致する", () => {
    // 既定バインドが解決できなければ意味がないので、comboOf の生成と突き合わせる
    expect(comboOf({ key: "F1", ctrlKey: true, shiftKey: false, altKey: false })).toBe("ctrl+F1");
    expect(comboOf({ key: "F3", ctrlKey: true, shiftKey: false, altKey: false })).toBe("ctrl+F3");
    keybindingsStore.reset();
    expect(keybindingsStore.resolve({ key: "F1", ctrlKey: true, shiftKey: false, altKey: false })).toBe("view:sosi");
    expect(keybindingsStore.resolve({ key: "F3", ctrlKey: true, shiftKey: false, altKey: false })).toBe("view:kana");
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
    expect(keybindingsStore.bindings["ctrl+F3"]).toBe("view:kana");
  });

  it("既定バインド導入前の保存値には一度だけ混ぜる（既存の割り当ては奪わない）", () => {
    localStorage.clear();
    localStorage.setItem("as400.keybindings", JSON.stringify({ "ctrl+F1": "F5", "ctrl+j": "F4" }));
    keybindingsStore.reload();
    expect(keybindingsStore.bindings["ctrl+F1"]).toBe("F5"); // 使用中のキーは保存値が優先
    expect(keybindingsStore.bindings["ctrl+F3"]).toBe("view:kana"); // 空いている方は既定が入る
    expect(keybindingsStore.bindings["ctrl+j"]).toBe("F4");
  });
});

describe("ローカル編集キー（local:*）", () => {
  // ~~Ctrl+Delete = Erase EOF・Ctrl+Backspace = Erase Input~~ → ACS の既定に直した（`20260921-delete-word`）。ACS `AcsMapFunctions.MAP_5250` は
  // `C127 = [deleteword]`・`C8`（Ctrl+Backspace）の割り当て無し・Erase EOF の既定キー無し。Erase Input は `A35`（Alt+End）
  it("既定で Field Exit（Ctrl+Enter）・Delete Word（Ctrl+Delete）・Erase Input（Alt+End）が割り当たる。Ctrl+Backspace と Erase EOF には無い（ACS と同じ）", () => {
    expect(DEFAULT_BINDINGS["ctrl+Enter"]).toBe("local:field-exit");
    expect(DEFAULT_BINDINGS["ctrl+Delete"]).toBe("local:delete-word");
    expect(DEFAULT_BINDINGS["alt+End"]).toBe("local:erase-input");
    expect(DEFAULT_BINDINGS["ctrl+Backspace"], "ACS に C8 の割り当ては無い（語を消す習慣で押すと全欄が消えていた）").toBeUndefined();
    expect(Object.values(DEFAULT_BINDINGS), "Erase EOF は既定のキーが無い").not.toContain("local:erase-eof");
  });

  it("local:* は判別でき、操作名を取り出せる", () => {
    expect(isLocalBinding("local:field-exit")).toBe(true);
    expect(isLocalBinding("view:kana")).toBe(false);
    expect(isLocalBinding("F3")).toBe(false);
    expect(localActionOf("local:erase-eof")).toBe("erase-eof");
  });

  it("**ホストへ送らず** local ハンドラーを呼ぶ", () => {
    const sendAid = vi.fn();
    const local = vi.fn();
    const prevent = vi.fn();
    const h = makeKeydownHandler({ sendAid, local, viewCycle: vi.fn(), playMacro: vi.fn(), isFocused: () => true });
    h({
      key: "Enter", ctrlKey: true, shiftKey: false, altKey: false, metaKey: false, preventDefault: prevent
    } as unknown as KeyboardEvent);
    expect(local).toHaveBeenCalledWith("field-exit");
    expect(sendAid).not.toHaveBeenCalled(); // Ctrl+Enter が素の Enter として飛ばない
    expect(prevent).toHaveBeenCalled(); // ブラウザ既定より優先
  });
});

describe("既定バインドの版更新", () => {
  // 版を上げたときに**その版で増えた分だけ**を混ぜる。全既定を混ぜ直すと、
  // 利用者が消した既定まで復活してしまう（「消したら消えたまま」の約束を破る）。
  it("旧版の保存値には、新版で増えた既定だけを足す（消した旧既定は復活しない）", () => {
    localStorage.clear();
    localStorage.setItem("as400.keybindings", JSON.stringify({ "ctrl+F3": "view:sosi" })); // ctrl+F1 は削除済み
    localStorage.setItem("as400.keybindings.version", "1");
    keybindingsStore.reload();
    expect(keybindingsStore.bindings["ctrl+F1"]).toBeUndefined(); // 版 1 の既定は復活しない
    expect(keybindingsStore.bindings["ctrl+Enter"]).toBe("local:field-exit"); // 版 2 の追加分は入る
  });

  it("最新版の保存値には何も足さない", () => {
    localStorage.clear();
    localStorage.setItem("as400.keybindings", JSON.stringify({ "ctrl+9": "F9" }));
    // **版番号を直書きしない。** 既定を 1 つ足して版を上げるたびにこのテストが落ちてしまう
    localStorage.setItem("as400.keybindings.version", String(BINDINGS_VERSION));
    keybindingsStore.reload();
    expect(keybindingsStore.bindings).toEqual({ "ctrl+9": "F9" });
  });

  it("版 2 の保存値には版 3 の追加分（符号確定・Dup）だけが入る", () => {
    localStorage.clear();
    localStorage.setItem("as400.keybindings", JSON.stringify({ "ctrl+Enter": "local:field-exit" }));
    localStorage.setItem("as400.keybindings.version", "2");
    keybindingsStore.reload();
    expect(keybindingsStore.bindings["ctrl+-"]).toBe("local:field-minus");
    expect(keybindingsStore.bindings["ctrl++"]).toBe("local:field-plus");
    expect(keybindingsStore.bindings["ctrl+d"]).toBe("local:dup");
    expect(keybindingsStore.bindings["ctrl+F1"], "版 1 の既定は復活しない").toBeUndefined();
  });
});

describe("既定バインドの訂正（Ctrl+Delete・Ctrl+Backspace。`20260921-delete-word`）", () => {
  const load = (bindings: Record<string, string>, version: number) => {
    localStorage.clear();
    localStorage.setItem("as400.keybindings", JSON.stringify(bindings));
    localStorage.setItem("as400.keybindings.version", String(version));
    keybindingsStore.reload();
  };

  it("**古い既定のまま（版 2〜4）の人は、Ctrl+Delete は Delete Word へ・Ctrl+Backspace は外れる**", () => {
    for (const v of [2, 3, 4]) {
      load({ "ctrl+Enter": "local:field-exit", "ctrl+Delete": "local:erase-eof", "ctrl+Backspace": "local:erase-input" }, v);
      expect(keybindingsStore.bindings["ctrl+Delete"], `版 ${v}`).toBe("local:delete-word");
      expect(keybindingsStore.bindings["ctrl+Backspace"], `版 ${v}`).toBeUndefined();
      expect(keybindingsStore.bindings["ctrl+Enter"], `版 ${v}`).toBe("local:field-exit"); // ほかは触らない
    }
  });

  it("**キーごとに独立して直す**: Ctrl+Delete を自分で変えた人の値・Ctrl+Backspace を自分で変えた人の値は残る", () => {
    load({ "ctrl+Delete": "F5", "ctrl+Backspace": "local:erase-input" }, 4);
    expect(keybindingsStore.bindings["ctrl+Delete"], "自分で割り当てた値は奪わない").toBe("F5");
    expect(keybindingsStore.bindings["ctrl+Backspace"], "古い既定のままのほうは外れる").toBeUndefined();
    load({ "ctrl+Delete": "local:erase-eof", "ctrl+Backspace": "F6" }, 4);
    expect(keybindingsStore.bindings["ctrl+Delete"]).toBe("local:delete-word");
    expect(keybindingsStore.bindings["ctrl+Backspace"]).toBe("F6");
  });

  it("**消した人のところへ復活させない**（Ctrl+Delete を外した人に Delete Word を足さない）", () => {
    load({ "ctrl+Enter": "local:field-exit" }, 4);
    expect(keybindingsStore.bindings["ctrl+Delete"]).toBeUndefined();
  });

  it("版 1 の人（Ctrl+Delete の既定が入る前）には、新しい既定の Delete Word が入る", () => {
    load({ "ctrl+F3": "view:sosi" }, 1);
    expect(keybindingsStore.bindings["ctrl+Delete"]).toBe("local:delete-word");
    expect(keybindingsStore.bindings["ctrl+Backspace"]).toBeUndefined();
  });

  it("Erase EOF を割り当てた人（Ctrl+Delete 以外のキー）は、そのまま使える", () => {
    load({ "ctrl+e": "local:erase-eof" }, 4);
    expect(keybindingsStore.bindings["ctrl+e"]).toBe("local:erase-eof");
  });
});

describe("ACS の既定の追加（版 5: Ctrl+Home＝罫線・Ctrl+F11＝カーソルの形。`20260921-default-keys-rule-cursor`）", () => {
  it("既定に入り、順送りの割り当て（view:*）として解決される", () => {
    expect(DEFAULT_BINDINGS["ctrl+Home"]).toBe("view:ruleLine");
    expect(DEFAULT_BINDINGS["ctrl+F11"]).toBe("view:cursorShape");
    expect(isViewBinding("view:ruleLine")).toBe(true);
  });

  it("**版 4 の保存値には追加分だけを足す**（既にそのキーを別用途に割り当てた人・消した既定は触らない）", () => {
    localStorage.clear();
    localStorage.setItem("as400.keybindings", JSON.stringify({ "ctrl+F11": "F11", "ctrl+Enter": "local:field-exit" }));
    localStorage.setItem("as400.keybindings.version", "4");
    keybindingsStore.reload();
    expect(keybindingsStore.bindings["ctrl+Home"], "空いているキーには既定が入る").toBe("view:ruleLine");
    expect(keybindingsStore.bindings["ctrl+F11"], "使用中のキーは保存値が優先").toBe("F11");
    expect(keybindingsStore.bindings["ctrl+Backspace"], "版 5 の訂正（Ctrl+Backspace は割り当て無し）とは別").toBeUndefined();
  });

  it("キー入力で表示設定の順送りが呼ばれ、ホストへは送らない", () => {
    const viewCycle = vi.fn();
    const sendAid = vi.fn();
    const h = makeKeydownHandler({ sendAid, local: vi.fn(), viewCycle, playMacro: vi.fn(), isFocused: () => true });
    localStorage.clear();
    keybindingsStore.reload();
    h({ key: "Home", ctrlKey: true, shiftKey: false, altKey: false, metaKey: false, preventDefault: vi.fn() } as unknown as KeyboardEvent);
    h({ key: "F11", ctrlKey: true, shiftKey: false, altKey: false, metaKey: false, preventDefault: vi.fn() } as unknown as KeyboardEvent);
    expect(viewCycle.mock.calls.map((c) => c[0])).toEqual(["ruleLine", "cursorShape"]);
    expect(sendAid).not.toHaveBeenCalled();
  });
});

describe("既定バインドの最新の版の数え方（独立点検 B-S4）", () => {
  it("**追加が無く訂正だけの版も数える**（数えないと、その版の訂正が古い既定のままの人へ届かない）", () => {
    expect(latestBindingsVersion({ 1: {}, 2: {} }, { 3: [] }), "訂正だけの版 3").toBe(3);
    expect(latestBindingsVersion({ 1: {}, 4: {} }, { 3: [] }), "追加のほうが新しい").toBe(4);
    expect(latestBindingsVersion({ 1: {}, 2: {} }, {}), "訂正が無い").toBe(2);
  });

  it("いまの版は追加・訂正の最大（テストが版番号を直書きしない）", () => {
    expect(BINDINGS_VERSION).toBeGreaterThanOrEqual(5);
  });
});
