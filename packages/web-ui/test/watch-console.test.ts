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

import type { PublicSession } from "@ts5250/server";
import { watchesStore } from "../src/stores/watches.js";
import { systemsStore } from "../src/stores/systems.js";
import WatchPane from "../src/components/WatchPane.vue";
import PaneTabs from "../src/components/PaneTabs.vue";
import { MSG_WATCH_CONSUMES } from "../src/composables/opMessages.js";

const W1 = {
  id: "w1",
  kind: "dtaq" as const,
  ref: "own:c1",
  label: "MYLIB/ORDERQ",
  // `listening`（旧 `watching`）。プリンターと語彙を共有する（`service-state.ts`）
  state: "listening" as const,
  received: 0,
  startedAt: "2026-07-30T00:00:00Z"
};
const W2 = { ...W1, id: "w2", ref: "own:c2", label: "MYLIB/LOGQ" };
/** メッセージ待ち行列の待ち受け。**こちらは消費しない**（`*SAME` で読む） */
const M1 = { ...W1, id: "m1", kind: "msgq" as const, ref: "own:m1", label: "QSYS/QSYSOPR" };

/**
 * 監視の由来の設定。**監視自身はシステムを持たない**ので、ここから引く
 * （`watchScope.ts`）。`W1`/`M1` は A のもの、`W2` は B のもの。
 */
const SESSIONS = [
  { ref: "own:c1", name: "注文", system: "own:s-A", sessionType: "dtaqwatch" },
  { ref: "own:c2", name: "ログ", system: "own:s-B", sessionType: "dtaqwatch" },
  { ref: "own:m1", name: "操作員", system: "own:s-A", sessionType: "msgwatch" }
] as PublicSession[];

/**
 * 既定は**設定を持たない**状態にしておく（絞り込みを見るテストだけが `SESSIONS` を入れる）。
 * `loaded` を立てるのは、`WatchPane` が設定を取りに行かないようにするため。
 */
beforeEach(() => {
  systemsStore.sessions = [];
  systemsStore.loaded = true;
});

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

  it("watch-list で一覧が入る", () => {
    deliver({ type: "watch-list", watches: [W1, W2] });
    expect(watchesStore.watches.map((w) => w.label)).toEqual(["MYLIB/ORDERQ", "MYLIB/LOGQ"]);
  });

  it("watch-entry で履歴が増え、未読が増える", () => {
    deliver({ type: "watch-list", watches: [W1] });
    deliver({ type: "watch-entry", watchId: "w1", entry: entry(1, "ORD-1"), received: 1 });
    expect(watchesStore.historyOf("w1").map((e) => e.text)).toEqual(["ORD-1"]);
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
    expect(watchesStore.historyOf("w1")).toHaveLength(1);
  });

  /**
   * **既読にする範囲を指定できる。** コンソールはシステムごとに分かれたので
   * （`watchScope.ts`）、開いたタブが全部を既読にすると、別システムの新着が
   * 読まれないまま消えてバッジが二度と出ない。
   */
  it("markRead は渡した監視だけを既読にする", () => {
    deliver({ type: "watch-list", watches: [W1, W2] });
    deliver({ type: "watch-entry", watchId: "w1", entry: entry(1, "a"), received: 1 });
    deliver({ type: "watch-entry", watchId: "w2", entry: entry(1, "b"), received: 1 });
    watchesStore.markRead(["w1"]);
    expect(watchesStore.unreadOf("w1")).toBe(0);
    expect(watchesStore.unreadOf("w2")).toBe(1);
  });

  it("状態の変化が反映される（黙って止まらない）", () => {
    deliver({ type: "watch-list", watches: [W1] });
    deliver({ type: "watch-state", watchId: "w1", state: "error", error: "not authorized" });
    expect(watchesStore.watches[0]).toMatchObject({ state: "error", error: "not authorized" });
    deliver({ type: "watch-state", watchId: "w1", state: "listening" });
    expect(watchesStore.watches[0]?.state).toBe("listening");
    expect(watchesStore.watches[0]?.error).toBeUndefined();
  });

  it("一覧から消えた監視の履歴・未読は捨てる（サーバーに無いものを持ち続けない）", () => {
    deliver({ type: "watch-list", watches: [W1, W2] });
    deliver({ type: "watch-entry", watchId: "w2", entry: entry(1, "x"), received: 1 });
    deliver({ type: "watch-list", watches: [W1] }); // w2 が停止された
    expect(watchesStore.totalUnread).toBe(0);
    expect(watchesStore.historyOf("w2")).toEqual([]);
  });

  it("ensureHistory は持っていなければ取り寄せる（一度届けば聞き直さない）", () => {
    deliver({ type: "watch-list", watches: [W1, W2] });
    captured.send.mockClear();
    watchesStore.ensureHistory("w2");
    expect(captured.send).toHaveBeenCalledWith({ type: "watch-history", watchId: "w2" });
    deliver({ type: "watch-history", watchId: "w2", entries: [entry(1, "hist")] });
    captured.send.mockClear();
    watchesStore.ensureHistory("w2");
    expect(captured.send).not.toHaveBeenCalled();
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

  it("**メッセージ待ち行列だけなら消費の注意は出さない**（出すと嘘になる）", async () => {
    const w = mount(WatchPane, { props: { tabId: "watch:queues" } });
    deliver({ type: "watch-list", watches: [M1] });
    await nextTick();
    expect(w.text()).not.toContain(MSG_WATCH_CONSUMES);
    // データ待ち行列が 1 本でも混じれば出る
    deliver({ type: "watch-list", watches: [M1, W1] });
    await nextTick();
    expect(w.text()).toContain(MSG_WATCH_CONSUMES);
    w.unmount();
  });

  it("待ち受けの種類が分かる", async () => {
    const w = mount(WatchPane, { props: { tabId: "watch:queues" } });
    deliver({ type: "watch-list", watches: [W1, M1] });
    await nextTick();
    expect(w.text()).toContain("メッセージ");
    expect(w.text()).toContain("データ");
    w.unmount();
  });

  it("**応答待ちは目立たせる**（見落とすとジョブが止まったままになる）", async () => {
    const w = mount(WatchPane, { props: { tabId: "watch:queues" } });
    deliver({ type: "watch-list", watches: [M1] }); // 1 本だけなので自動で選ばれる
    deliver({
      type: "watch-entry",
      watchId: "m1",
      received: 1,
      entry: {
        seq: 1,
        at: 0,
        text: "Attributes of file QPDSPJOB not supported.",
        bytes: 42,
        message: { key: "00002290", id: "CPA3303", type: "INQUIRY", severity: 99, inquiry: true }
      }
    });
    await nextTick();
    expect(w.text()).toContain("応答待ち");
    expect(w.text()).toContain("CPA3303");
    expect(w.find("li.inq").exists()).toBe(true);
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
    const w = mount(WatchPane, { props: { tabId: "watch:queues", active: true } });
    await nextTick();
    expect(watchesStore.totalUnread).toBe(0);
    w.unmount();
  });

  /**
   * **隠れている間は既読にしない**（`20260802-keep-pane-state`）。
   *
   * 開いたタブは切り替えてもアンマウントせず `v-show` で隠すようになった。
   * 「マウント中ずっと既読」のままだと、**裏で全部既読にして未読バッジが二度と出ない**。
   */
  it("**隠れている間の到着は未読のまま**（タブに戻ると消える）", async () => {
    deliver({ type: "watch-list", watches: [W1] });
    const w = mount(WatchPane, { props: { tabId: "watch:queues", active: false } });
    await nextTick();
    deliver({ type: "watch-entry", watchId: "w1", entry: entry(1, "a"), received: 1 });
    await nextTick();
    expect(watchesStore.totalUnread, "隠れているのに既読にしている").toBe(1);

    await w.setProps({ active: true });
    await nextTick();
    expect(watchesStore.totalUnread, "見えたのに未読が残っている").toBe(0);
    w.unmount();
  });

  /**
   * **一覧が届いたら先頭を選び、履歴を取り寄せる。** 以前は store がやっていたが、
   * コンソールがシステムごとに分かれて選択が画面側のものになった（`watchScope.ts`）。
   * ここが抜けるとリロード後に「監視は出ているのに履歴が空」になる（実機 E2E で踏んだ）。
   */
  it("一覧が届いたら先頭の履歴を取り寄せる（リロード後の空白を作らない）", async () => {
    const w = mount(WatchPane, { props: { tabId: "watch:queues" } });
    await nextTick();
    captured.send.mockClear();
    deliver({ type: "watch-list", watches: [W1, W2] });
    await nextTick();
    expect(captured.send).toHaveBeenCalledWith({ type: "watch-history", watchId: "w1" });
    w.unmount();
  });

  it("行を選ぶとその履歴に切り替わる", async () => {
    const w = mount(WatchPane, { props: { tabId: "watch:queues" } });
    deliver({ type: "watch-list", watches: [W1, W2] });
    deliver({ type: "watch-history", watchId: "w2", entries: [entry(1, "LOG-1")] });
    await nextTick();
    await w.findAll("tbody tr")[1]!.trigger("click");
    await nextTick();
    expect(w.find(".hist").text()).toContain("MYLIB/LOGQ");
    expect(w.find(".entries").text()).toContain("LOG-1");
    w.unmount();
  });
});

/**
 * **1 枚 = 1 システム**（`watchScope.ts`）。タブにシステムカラーの帯を出す以上、
 * 中身も 1 システムぶんでなければ帯が嘘になる（利用者の指摘が発端）。
 */
describe("WatchPane: システムごとの絞り込み", () => {
  beforeEach(async () => {
    watchesStore.reset();
    await watchesStore.connect();
    systemsStore.sessions = SESSIONS;
  });

  const mountFor = (sys: string) =>
    mount(WatchPane, { props: { tabId: `watch:queues@${sys}`, active: true } });

  it("そのシステムの監視だけを出す", async () => {
    const w = mountFor("own:s-A");
    deliver({ type: "watch-list", watches: [W1, W2] });
    await nextTick();
    expect(w.text()).toContain("MYLIB/ORDERQ");
    expect(w.text()).not.toContain("MYLIB/LOGQ");
    w.unmount();
  });

  it("システムを持たない古いタブは全部出す（作り直させない）", async () => {
    const w = mount(WatchPane, { props: { tabId: "watch:queues" } });
    deliver({ type: "watch-list", watches: [W1, W2] });
    await nextTick();
    expect(w.text()).toContain("MYLIB/ORDERQ");
    expect(w.text()).toContain("MYLIB/LOGQ");
    w.unmount();
  });

  /**
   * **設定を引けない監視は落とさない。** 他人の個人設定で始まった監視を管理者が
   * 見ている場合など、`ref` から設定に辿り着けないことがある。落とすと
   * **消費し続けているものが画面から消える**——重複して見えるほうがはるかに軽い。
   */
  it("設定を引けない監視はどのタブにも出す", async () => {
    const w = mountFor("own:s-A");
    deliver({ type: "watch-list", watches: [{ ...W1, id: "x1", ref: "own:unknown", label: "謎/Q" }] });
    await nextTick();
    expect(w.text()).toContain("謎/Q");
    w.unmount();
  });

  /** 既読も 1 システムぶん——全部消すと別システムのバッジが二度と出ない */
  it("既読にするのは出ている監視だけ", async () => {
    deliver({ type: "watch-list", watches: [W1, W2] });
    deliver({ type: "watch-entry", watchId: "w1", entry: entry(1, "a"), received: 1 });
    deliver({ type: "watch-entry", watchId: "w2", entry: entry(1, "b"), received: 1 });
    const w = mountFor("own:s-A");
    await nextTick();
    expect(watchesStore.unreadOf("w1")).toBe(0);
    expect(watchesStore.unreadOf("w2"), "別システムまで既読にしている").toBe(1);
    w.unmount();
  });

  /**
   * **消費の注意もそのタブの中身で決める。** メッセージ待ち受けしか無いシステムで
   * 出すと嘘になる（`*SAME` で読むので消費しない）。
   */
  it("メッセージ待ち受けしか無いシステムでは消費の注意を出さない", async () => {
    const w = mountFor("own:s-A");
    deliver({ type: "watch-list", watches: [M1, W2] });
    await nextTick();
    expect(w.text()).not.toContain(MSG_WATCH_CONSUMES);
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
  function mountTabs(tabs = ["watch:queues"]) {
    return mount(PaneTabs, {
      props: { group: { id: "g1", tabs, activeTab: tabs[0] } } as never,
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
    expect(badge.text()).toBe("2"); // このタブに出るキューの合計
    expect(badge.attributes("title")).toBe("新着エントリ");
    w.unmount();
  });

  /**
   * **タブにシステムカラーの帯が出る**（利用者の指摘が発端）。
   *
   * 帯は `--tab-sys` の有無で出る（`.tab[style*="--tab-sys"]`）。監視コンソールだけが
   * システムに紐づかない 1 枚だったため、ここが空で帯が付いていなかった。
   */
  it("**監視コンソールのタブにシステムカラーが付く**", async () => {
    const w = mountTabs(["watch:queues@own:s-A"]);
    await nextTick();
    expect(w.find(".tab").attributes("style")).toContain("--tab-sys");
    w.unmount();
  });

  /**
   * **別システムの新着でバッジを光らせない**（`watchScope.ts`）。
   * コンソールはシステムごとに分かれたので、全合計を出すと
   * 「開いても何も無いのにバッジだけ出ている」になる。
   */
  it("**そのシステムの未読だけを数える**", async () => {
    systemsStore.sessions = SESSIONS;
    deliver({ type: "watch-list", watches: [W1, W2] });
    deliver({ type: "watch-entry", watchId: "w1", entry: entry(1, "a"), received: 1 });
    deliver({ type: "watch-entry", watchId: "w2", entry: entry(1, "b"), received: 1 });
    const w = mountTabs(["watch:queues@own:s-A"]);
    await nextTick();
    expect(w.find(".badge").text()).toBe("1");
    w.unmount();
  });
});
