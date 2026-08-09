/**
 * **監視セッション（`dtaqwatch`）の接続はセッションを開かない。**
 *
 * 監視はサーバーのレジストリが所有する（`20260723-dtaq-watch-notify` research F1）。
 * ランチャーの「接続」は
 *
 * 1. 装置名の重複判定を**通さない**（監視は装置名を持たない。research F5。
 *    通すと `undefined` 同士で誤って「使用中」に見えるうえ、1 装置 1 接続の制約が無い）
 * 2. 5250 / プリンターのセッションを開かない（`openSession` を呼ばない）
 * 3. 監視を始めて**監視コンソールのタブを開く**
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mount, flushPromises } from "@vue/test-utils";
import type { PublicSession, PublicSystem } from "@ts5250/server";

const openSession = vi.fn();
const openPrinterSession = vi.fn();
vi.mock("../src/session-controller.js", () => ({
  openSession: (...a: never[]) => openSession(...a),
  openPrinterSession: (...a: never[]) => openPrinterSession(...a),
  sendKey: vi.fn(),
  closeSession: vi.fn(),
  noteActivity: vi.fn()
}));

const watchStart = vi.fn((_ref: string) => Promise.resolve());
const watchConnect = vi.fn(() => Promise.resolve());
vi.mock("../src/stores/watches.js", () => ({
  watchesStore: {
    start: (ref: string) => watchStart(ref),
    connect: () => watchConnect(),
    // **同じ設定の監視が既にあるかを見る**ので、一覧も持たせる
    watches: [] as { ref: string }[],
    get totalUnread() {
      return 0;
    }
  }
}));

import LauncherPane from "../src/components/LauncherPane.vue";
import ConfigCard from "../src/components/ConfigCard.vue";
import { systemsStore } from "../src/stores/systems.js";
import { sessionsStore, type SessionState } from "../src/stores/sessions.js";
import { workspaceStore } from "../src/stores/workspace.js";
import { authStore } from "../src/stores/auth.js";

const SYSTEM: PublicSystem = { ref: "own:s-1", name: "JP", host: "h", autoSignon: false };
const WATCH: PublicSession = {
  ref: "own:w-1",
  name: "注文キュー",
  system: "own:s-1",
  sessionType: "dtaqwatch",
  dtaqWatch: { library: "MARO1", name: "ORDERQ" }
} as PublicSession;

beforeEach(() => {
  openSession.mockClear();
  openPrinterSession.mockClear();
  watchStart.mockClear();
  watchConnect.mockClear();
  systemsStore.systems = [SYSTEM];
  systemsStore.sessions = [WATCH];
  systemsStore.menuSystem = SYSTEM.ref;
  systemsStore.loaded = true;
  authStore.enabled = false;
  sessionsStore.byId.clear();
  sessionsStore.order = [];
  workspaceStore.init();
  // **`onMounted` の `refresh()` が上書きするので、この 2 本は本物の形で返す**
  // （`{}` を返すと systems/sessions が空になり、カードが 1 枚も出ない）
  vi.stubGlobal("fetch", (url: string) => {
    const u = String(url);
    if (u === "/api/systems") {
      return Promise.resolve(
        new Response(JSON.stringify({ systems: [SYSTEM], editable: false }), { status: 200 })
      );
    }
    if (u === "/api/sessions-config") {
      return Promise.resolve(new Response(JSON.stringify({ sessions: [WATCH] }), { status: 200 }));
    }
    return Promise.resolve(new Response("{}", { status: 200 }));
  });
});
afterEach(() => vi.unstubAllGlobals());

/**
 * カードの「接続」を押す。`ConfigCard` は `open` イベントを出すだけなので、
 * 既存テスト（`launcher-open-existing.test.ts`）と同じく emit で叩く。
 */
async function connect(w: ReturnType<typeof mount>): Promise<void> {
  await w.findComponent(ConfigCard).vm.$emit("open", WATCH.ref);
  await flushPromises();
}

describe("dtaqwatch の接続", () => {
  it("監視を始める（設定の ref を渡す）", async () => {
    const w = mount(LauncherPane);
    await flushPromises();
    await connect(w);
    expect(watchStart).toHaveBeenCalledWith("own:w-1");
    w.unmount();
  });

  it("**5250 / プリンターのセッションは開かない**", async () => {
    const w = mount(LauncherPane);
    await flushPromises();
    await connect(w);
    expect(openSession).not.toHaveBeenCalled();
    expect(openPrinterSession).not.toHaveBeenCalled();
    w.unmount();
  });

  /**
   * **タブはそのシステムのもの**（`watchScope.ts`）。ID にシステムを載せないと
   * タブ帯にシステムカラーが付かず、他のアプリ系タブと見え方が揃わない（利用者の指摘）。
   */
  it("監視コンソールのタブが**そのシステムで**開く", async () => {
    const w = mount(LauncherPane);
    await flushPromises();
    await connect(w);
    const tab = "watch:queues@own:s-1";
    expect(workspaceStore.groups().some((g) => g.tabs.includes(tab))).toBe(true);
    expect(workspaceStore.systemOf(tab)).toBe("own:s-1");
    w.unmount();
  });

  it("**同じ設定の監視が既にあれば二重に始めない**（消費が二重になるのを防ぐ）", async () => {
    const { watchesStore } = await import("../src/stores/watches.js");
    (watchesStore.watches as { ref: string }[]).push({ ref: "own:w-1" });
    const w = mount(LauncherPane);
    await flushPromises();
    await connect(w);
    expect(watchStart).not.toHaveBeenCalled();
    expect(watchConnect).toHaveBeenCalled(); // 購読だけし直してコンソールを開く
    (watchesStore.watches as { ref: string }[]).length = 0;
    w.unmount();
  });

  /**
   * **装置名の重複判定を通さないこと。** 監視は装置名を持たないので、
   * 装置名なしのセッションが既に開いていると `undefined === undefined` で
   * 「使用中」と誤判定しうる（通していたら監視が始められない）。
   */
  it("装置名を持たないセッションが開いていても始められる", async () => {
    sessionsStore.add({
      sessionId: "s1",
      label: "他",
      snapshot: undefined,
      edits: new Map(),
      cursor: { row: 1, col: 1 },
      connected: true,
      readOnly: false,
      client: { close: () => {}, send: () => {} } as unknown as SessionState["client"]
    });
    const w = mount(LauncherPane);
    await flushPromises();
    await connect(w);
    expect(watchStart).toHaveBeenCalledWith("own:w-1");
    expect(w.find(".err").exists()).toBe(false);
    w.unmount();
  });
});
