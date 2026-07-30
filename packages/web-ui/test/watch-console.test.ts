/**
 * 監視コンソール（`20260723-dtaq-watch-notify`）。
 *
 * 要件のうち画面側が担うのはこの 3 点:
 *
 * 1. **到着に画面操作なしで気づける**——タブの未読バッジ（全キュー合計）と行ごとの未読
 * 2. **タブを開いたら未読が消える**（プリンターと同じ挙動）
 * 3. **監視は消費する**注意が**常時**出ている（開始時だけの表示にしない）
 *
 * store は**サーバーの写し**なので、真実（一覧）は常に `watch-list` で上書きされる。
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { mount } from "@vue/test-utils";
import { nextTick } from "vue";

/** WsClient をモック（connect 即時解決・send スパイ・handlers 捕捉） */
let captured: { handlers: { onServerMessage: (m: unknown) => void }; send: ReturnType<typeof vi.fn> };
vi.mock("../src/ws-client.js", () => ({
  wsUrl: () => "ws://test/ws",
  WsClient: class {
    send = vi.fn();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    constructor(_url: string, handlers: any) {
      captured = { handlers, send: this.send };
    }
    connect() {
      return Promise.resolve();
    }
    close() {}
    setHiddenIndexes() {}
    setSessionId() {}
  }
}));

import { watchesStore } from "../src/stores/watches.js";
import WatchPane from "../src/components/WatchPane.vue";
import PaneTabs from "../src/components/PaneTabs.vue";
import { MSG_WATCH_CONSUMES } from "../src/composables/opMessages.js";

const W1 = {
  id: "w1",
  kind: "dtaq" as const,
  ref: "own:c1",
  label: "MYLIB/ORDERQ",
  state: "watching" as const,
  received: 0,
  startedAt: "2026-07-30T00:00:00Z"
};
const W2 = { ...W1, id: "w2", ref: "own:c2", label: "MYLIB/LOGQ" };

const deliver = (m: unknown): void => captured.handlers.onServerMessage(m);
const entry = (seq: number, text: string) => ({ seq, at: 1_000_000, text, bytes: text.length });

describe("watchesStore: サーバーの写し", () => {
  beforeEach(async () => {
    watchesStore.reset();
    await watchesStore.connect();
    captured.send.mockClear();
  });

  it("購読すると watch-subscribe を送る", async () => {
    watchesStore.reset();
    await watchesStore.connect();
    expect(captured.send).toHaveBeenCalledWith({ type: "watch-subscribe" });
  });

  it("watch-list で一覧が入り、先頭が選ばれる", () => {
    deliver({ type: "watch-list", watches: [W1, W2] });
    expect(watchesStore.watches.map((w) => w.label)).toEqual(["MYLIB/ORDERQ", "MYLIB/LOGQ"]);
    expect(watchesStore.selected).toBe("w1");
  });

  it("watch-entry で履歴が増え、未読が増える", () => {
    deliver({ type: "watch-list", watches: [W1] });
    deliver({ type: "watch-entry", watchId: "w1", entry: entry(1, "ORD-1"), received: 1 });
    expect(watchesStore.history.map((e) => e.text)).toEqual(["ORD-1"]);
    expect(watchesStore.unreadOf("w1")).toBe(1);
    expect(watchesStore.watches[0]?.received).toBe(1);
  });

  it("**未読は全キューの合計**（タブのバッジ）", () => {
    deliver({ type: "watch-list", watches: [W1, W2] });
    deliver({ type: "watch-entry", watchId: "w1", entry: entry(1, "a"), received: 1 });
    deliver({ type: "watch-entry", watchId: "w2", entry: entry(1, "b"), received: 1 });
    deliver({ type: "watch-entry", watchId: "w2", entry: entry(2, "c"), received: 2 });
    expect(watchesStore.totalUnread).toBe(3);
    expect(watchesStore.unreadOf("w2")).toBe(2);
  });

  it("markRead で未読が消える（履歴は残る）", () => {
    deliver({ type: "watch-list", watches: [W1] });
    deliver({ type: "watch-entry", watchId: "w1", entry: entry(1, "a"), received: 1 });
    watchesStore.markRead();
    expect(watchesStore.totalUnread).toBe(0);
    expect(watchesStore.history).toHaveLength(1);
  });

  it("状態の変化が反映される（黙って止まらない）", () => {
    deliver({ type: "watch-list", watches: [W1] });
    deliver({ type: "watch-state", watchId: "w1", state: "error", error: "not authorized" });
    expect(watchesStore.watches[0]).toMatchObject({ state: "error", error: "not authorized" });
    deliver({ type: "watch-state", watchId: "w1", state: "watching" });
    expect(watchesStore.watches[0]?.state).toBe("watching");
    expect(watchesStore.watches[0]?.error).toBeUndefined();
  });

  it("一覧から消えた監視の履歴・未読は捨てる（サーバーに無いものを持ち続けない）", () => {
    deliver({ type: "watch-list", watches: [W1, W2] });
    deliver({ type: "watch-entry", watchId: "w2", entry: entry(1, "x"), received: 1 });
    deliver({ type: "watch-list", watches: [W1] }); // w2 が停止された
    expect(watchesStore.totalUnread).toBe(0);
    expect(watchesStore.selected).toBe("w1");
  });

  /**
   * **一覧が来た時点で履歴も取り寄せる。** リロード後は
   * 「監視は出ているのに履歴が空」になっていた（実機 E2E で踏んだ）。
   * requirement の「開き直すと閉じていた間の到着が履歴にある」がこれ。
   */
  it("watch-list が来たら選択中の履歴を取り寄せる（リロード後の空白を作らない）", () => {
    captured.send.mockClear();
    deliver({ type: "watch-list", watches: [W1] });
    expect(captured.send).toHaveBeenCalledWith({ type: "watch-history", watchId: "w1" });
  });

  it("既に履歴を持っていれば取り寄せ直さない", () => {
    deliver({ type: "watch-list", watches: [W1] });
    deliver({ type: "watch-history", watchId: "w1", entries: [entry(1, "x")] });
    captured.send.mockClear();
    deliver({ type: "watch-list", watches: [W1] });
    expect(captured.send).not.toHaveBeenCalled();
  });

  it("行を選ぶと履歴を持っていなければ取り寄せる", () => {
    deliver({ type: "watch-list", watches: [W1, W2] });
    captured.send.mockClear();
    watchesStore.select("w2");
    expect(captured.send).toHaveBeenCalledWith({ type: "watch-history", watchId: "w2" });
    // 一度届けば取り寄せ直さない
    deliver({ type: "watch-history", watchId: "w2", entries: [entry(1, "hist")] });
    captured.send.mockClear();
    watchesStore.select("w1");
    watchesStore.select("w2");
    expect(captured.send).not.toHaveBeenCalledWith({ type: "watch-history", watchId: "w2" });
  });

  it("開始・停止のメッセージを送る", async () => {
    await watchesStore.start("own:c9");
    expect(captured.send).toHaveBeenCalledWith({ type: "watch-start", session: "own:c9" });
    watchesStore.stop("w1");
    expect(captured.send).toHaveBeenCalledWith({ type: "watch-stop", watchId: "w1" });
  });
});

describe("WatchPane", () => {
  beforeEach(async () => {
    watchesStore.reset();
    await watchesStore.connect();
  });

  it("**消費する注意が常時出ている**（開始時だけの表示にしない）", async () => {
    const w = mount(WatchPane, { props: { tabId: "watch:queues" } });
    await nextTick();
    expect(w.text()).toContain(MSG_WATCH_CONSUMES);
    // 監視が動いていても出続ける
    deliver({ type: "watch-list", watches: [W1] });
    await nextTick();
    expect(w.text()).toContain(MSG_WATCH_CONSUMES);
    w.unmount();
  });

  it("監視が無ければ案内を出す", async () => {
    const w = mount(WatchPane, { props: { tabId: "watch:queues" } });
    await nextTick();
    expect(w.text()).toContain("監視はありません");
    w.unmount();
  });

  it("一覧に受信・未読・状態が出る", async () => {
    const w = mount(WatchPane, { props: { tabId: "watch:queues" } });
    deliver({ type: "watch-list", watches: [{ ...W1, received: 12 }] });
    deliver({ type: "watch-entry", watchId: "w1", entry: entry(13, "ORD-13"), received: 13 });
    await nextTick();
    const row = w.find("tbody tr");
    expect(row.text()).toContain("MYLIB/ORDERQ");
    expect(row.text()).toContain("13");
    expect(row.text()).toContain("監視中");
    w.unmount();
  });

  it("エラー状態が一覧に出る（黙って止まらない）", async () => {
    const w = mount(WatchPane, { props: { tabId: "watch:queues" } });
    deliver({ type: "watch-list", watches: [{ ...W1, state: "error", error: "not authorized" }] });
    await nextTick();
    expect(w.find("tbody tr").text()).toContain("エラー");
    expect(w.find(".state").attributes("title")).toBe("not authorized");
    w.unmount();
  });

  it("履歴は新しいものが上", async () => {
    const w = mount(WatchPane, { props: { tabId: "watch:queues" } });
    deliver({ type: "watch-list", watches: [W1] });
    deliver({ type: "watch-entry", watchId: "w1", entry: entry(1, "古い"), received: 1 });
    deliver({ type: "watch-entry", watchId: "w1", entry: entry(2, "新しい"), received: 2 });
    await nextTick();
    const items = w.findAll(".entries li");
    expect(items[0]?.text()).toContain("新しい");
    expect(items[1]?.text()).toContain("古い");
    w.unmount();
  });

  it("停止ボタンで watch-stop を送る", async () => {
    const w = mount(WatchPane, { props: { tabId: "watch:queues" } });
    deliver({ type: "watch-list", watches: [W1] });
    await nextTick();
    captured.send.mockClear();
    await w.find("tbody tr button").trigger("click");
    expect(captured.send).toHaveBeenCalledWith({ type: "watch-stop", watchId: "w1" });
    w.unmount();
  });

  it("**開いたら未読が消える**（プリンターと同じ挙動）", async () => {
    deliver({ type: "watch-list", watches: [W1] });
    deliver({ type: "watch-entry", watchId: "w1", entry: entry(1, "a"), received: 1 });
    expect(watchesStore.totalUnread).toBe(1);
    const w = mount(WatchPane, { props: { tabId: "watch:queues" } });
    await nextTick();
    expect(watchesStore.totalUnread).toBe(0);
    w.unmount();
  });
});

describe("PaneTabs: pane タブの未読バッジ", () => {
  beforeEach(async () => {
    watchesStore.reset();
    await watchesStore.connect();
  });

  /**
   * **セッションを持たないタブに未読を出せること**が要件（research F6）。
   * `sessionsStore.get()` は pane タブの id では何も返さないので、
   * 分岐が無いと監視の未読は永久に出ない。
   */
  function mountTabs() {
    return mount(PaneTabs, {
      props: {
        group: { id: "g1", tabs: ["watch:queues"], activeTab: "watch:queues" }
      } as never,
      global: { stubs: { SessionInfo: true } }
    });
  }

  it("未読が無ければバッジは出ない", async () => {
    const w = mountTabs();
    await nextTick();
    expect(w.find(".badge").exists()).toBe(false);
    w.unmount();
  });

  it("**監視の未読がタブのバッジに出る**", async () => {
    deliver({ type: "watch-list", watches: [W1, W2] });
    deliver({ type: "watch-entry", watchId: "w1", entry: entry(1, "a"), received: 1 });
    deliver({ type: "watch-entry", watchId: "w2", entry: entry(1, "b"), received: 1 });
    const w = mountTabs();
    await nextTick();
    const badge = w.find(".badge");
    expect(badge.exists()).toBe(true);
    expect(badge.text()).toBe("2"); // 全キュー合計
    expect(badge.attributes("title")).toBe("新着エントリ");
    w.unmount();
  });
});
