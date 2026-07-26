import { describe, it, expect, vi, beforeEach } from "vitest";
import { mount } from "@vue/test-utils";
import { nextTick } from "vue";
import type { Cell, Field, ScreenSnapshot } from "@as400web/core";
import type { PublicMacro } from "@as400web/server";
import type { WsClient } from "../src/ws-client.js";
import StatusBar from "../src/components/StatusBar.vue";
import MacroMenu from "../src/components/MacroMenu.vue";
import { sessionsStore, type MacroRuntime, type SessionState } from "../src/stores/sessions.js";
import { macrosStore } from "../src/stores/macros.js";
import { makeKeydownHandler } from "../src/composables/useKeymap.js";
import { keybindingsStore } from "../src/stores/keybindings.js";
import { openHeaderMenu } from "../src/composables/headerMenu.js";

const SID = "mac1";

function cell(ch = " "): Cell {
  return {
    char: ch, kind: "sbcs", color: "green", reverse: false, underline: false,
    blink: false, columnSeparator: false, nonDisplay: false
  };
}

function field(over: Partial<Field> & { index: number }): Field {
  return {
    row: 5, col: 25, length: 10, protected: false, hidden: false,
    numeric: false, mdt: false, value: "", ...over
  };
}

function snapshot(): ScreenSnapshot {
  return {
    sessionId: SID,
    rows: 24,
    cols: 80,
    cursor: { row: 5, col: 25 },
    keyboardLocked: false,
    cells: Array.from({ length: 24 }, () => Array.from({ length: 80 }, () => cell())),
    fields: [field({ index: 1 })]
  };
}

function makeSession(macro?: MacroRuntime): SessionState {
  const s: SessionState = {
    sessionId: SID,
    label: "t",
    snapshot: snapshot(),
    edits: new Map(),
    cursor: { row: 5, col: 25 },
    connected: true,
    readOnly: false,
    client: { send: vi.fn() } as unknown as WsClient,
    ...(macro ? { macro } : {})
  };
  sessionsStore.byId.clear();
  sessionsStore.order = [];
  sessionsStore.add(s);
  return sessionsStore.get(SID)!;
}

function macro(over: Partial<PublicMacro> = {}): PublicMacro {
  return {
    id: "m-1", name: "サインオン", createdAt: 0, updatedAt: 0,
    hasSecret: false, steps: [], ...over
  };
}

beforeEach(() => {
  macrosStore.macros = [];
  macrosStore.canStoreSecrets = true;
  macrosStore.loaded = true;
  openHeaderMenu.value = null;
});

describe("OIA のマクロ状態表示（A5）", () => {
  const cases: { mode: MacroRuntime["mode"]; text: string }[] = [
    { mode: "recording", text: "⏺ 記録中" },
    { mode: "recordPaused", text: "⏸ 記録休止" },
    { mode: "playing", text: "▶ 再生中" },
    { mode: "playPaused", text: "⏸ 再生休止" }
  ];

  for (const c of cases) {
    it(`${c.mode} は「${c.text}」を出す`, () => {
      const state = makeSession({ mode: c.mode, steps: [], index: 0 });
      const w = mount(StatusBar, { props: { state } });
      expect(w.text()).toContain(c.text);
      expect(w.find(".macro").attributes("role")).toBe("status");
    });
  }

  it("idle では何も出さない", () => {
    const state = makeSession({ mode: "idle", steps: [], index: 0 });
    const w = mount(StatusBar, { props: { state } });
    expect(w.find(".macro").exists()).toBe(false);
  });

  it("マクロを一度も使っていなければ何も出さない", () => {
    const state = makeSession();
    const w = mount(StatusBar, { props: { state } });
    expect(w.find(".macro").exists()).toBe(false);
  });

  it("異常終了の理由を出す（画面不一致）", () => {
    const state = makeSession({
      mode: "idle", steps: [], index: 0,
      stopReason: "mismatch", message: "画面が一致しません（ステップ 2）"
    });
    const w = mount(StatusBar, { props: { state } });
    expect(w.text()).toContain("画面が一致しません（ステップ 2）");
  });

  it("正常終了（completed / user）は理由を出さない", () => {
    for (const reason of ["completed", "user"] as const) {
      const state = makeSession({ mode: "idle", steps: [], index: 0, stopReason: reason });
      const w = mount(StatusBar, { props: { state } });
      expect(w.find(".macro").exists()).toBe(false);
    }
  });
});

describe("マクロメニュー（A6）", () => {
  it("閉じているときは一覧を出さない", () => {
    makeSession();
    const w = mount(MacroMenu, { props: { sessionId: SID } });
    expect(w.find(".mcm-menu").exists()).toBe(false);
  });

  it("開くと保存済みマクロが並び、秘密ありには鍵が付く", async () => {
    makeSession();
    macrosStore.macros = [macro(), macro({ id: "m-2", name: "自動ログイン", hasSecret: true })];
    const w = mount(MacroMenu, { props: { sessionId: SID } });

    await w.find(".mcm-btn").trigger("click");
    const names = w.findAll(".mcm-name");
    expect(names).toHaveLength(2);
    expect(names[0]!.text()).toContain("サインオン");
    expect(names[0]!.text()).not.toContain("🔑");
    expect(names[1]!.text()).toContain("自動ログイン");
    expect(names[1]!.text()).toContain("🔑");
  });

  it("保存済みが無ければその旨を出す", async () => {
    makeSession();
    const w = mount(MacroMenu, { props: { sessionId: SID } });
    await w.find(".mcm-btn").trigger("click");
    expect(w.text()).toContain("まだありません");
  });

  it("idle では「記録」、記録中は「休止 / 停止」を出す", async () => {
    makeSession();
    const w = mount(MacroMenu, { props: { sessionId: SID } });
    await w.find(".mcm-btn").trigger("click");
    expect(w.text()).toContain("⏺ 記録");

    sessionsStore.get(SID)!.macro = { mode: "recording", steps: [], index: 0 };
    await nextTick();
    expect(w.text()).toContain("⏸ 休止");
    expect(w.text()).toContain("⏹ 停止");
    expect(w.text()).not.toContain("⏺ 記録\n");
  });

  it("休止中は「再開」に変わる", async () => {
    makeSession({ mode: "recordPaused", steps: [], index: 0 });
    const w = mount(MacroMenu, { props: { sessionId: SID } });
    await w.find(".mcm-btn").trigger("click");
    expect(w.text()).toContain("▶ 再開");
  });

  it("記録ボタンで記録が始まる", async () => {
    const state = makeSession();
    const w = mount(MacroMenu, { props: { sessionId: SID } });
    await w.find(".mcm-btn").trigger("click");
    await w.findAll(".mcm-act").find((b) => b.text().includes("記録"))!.trigger("click");
    expect(state.macro?.mode).toBe("recording");
  });

  it("記録中・再生中は一覧から再生できない", async () => {
    makeSession({ mode: "recording", steps: [], index: 0 });
    macrosStore.macros = [macro()];
    const w = mount(MacroMenu, { props: { sessionId: SID } });
    await w.find(".mcm-btn").trigger("click");
    expect(w.find(".mcm-name").attributes("disabled")).toBeDefined();
  });

  it("ボタンのラベル幅は固定（切り替えで隣がずれない）", async () => {
    makeSession();
    const w = mount(MacroMenu, { props: { sessionId: SID } });
    // ラベルは専用 span で包まれている（幅は CSS で固定。UI-DESIGN の鉄則）
    expect(w.find(".mcm-lbl").exists()).toBe(true);
  });

  it("記録中はボタンに rec クラスが付く（色で分かる）", async () => {
    makeSession({ mode: "recording", steps: [], index: 0 });
    const w = mount(MacroMenu, { props: { sessionId: SID } });
    expect(w.find(".mcm-btn").classes()).toContain("rec");
  });

  it("ヘッダーメニューは同時に 1 つだけ（他が開いていれば閉じている）", () => {
    makeSession();
    openHeaderMenu.value = "view";
    const w = mount(MacroMenu, { props: { sessionId: SID } });
    expect(w.find(".mcm-menu").exists()).toBe(false);
  });
});

describe("マクロのキー割り当て（macro:<id>）", () => {
  beforeEach(() => {
    keybindingsStore.bindings = {};
  });

  it("macro: バインドは playMacro へ回り、ホストへ送らない", () => {
    keybindingsStore.set("ctrl+9", "macro:m-1");
    const sendAid = vi.fn();
    const playMacro = vi.fn();
    const viewCycle = vi.fn();
    const handler = makeKeydownHandler({
      sendAid, playMacro, viewCycle, local: vi.fn(), isFocused: () => true
    });

    handler({
      key: "9", ctrlKey: true, shiftKey: false, altKey: false, metaKey: false,
      preventDefault: vi.fn()
    } as unknown as KeyboardEvent);

    expect(playMacro).toHaveBeenCalledWith("m-1");
    expect(sendAid).not.toHaveBeenCalled();
    expect(viewCycle).not.toHaveBeenCalled();
  });

  it("AID バインドは従来どおりホストへ送る（回帰）", () => {
    keybindingsStore.set("ctrl+8", "F5");
    const sendAid = vi.fn();
    const playMacro = vi.fn();
    const handler = makeKeydownHandler({
      sendAid, playMacro, viewCycle: vi.fn(), local: vi.fn(), isFocused: () => true
    });

    handler({
      key: "8", ctrlKey: true, shiftKey: false, altKey: false, metaKey: false,
      preventDefault: vi.fn()
    } as unknown as KeyboardEvent);

    expect(sendAid).toHaveBeenCalledWith("F5");
    expect(playMacro).not.toHaveBeenCalled();
  });
});
