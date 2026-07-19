import { describe, it, expect, beforeEach } from "vitest";
import { mount } from "@vue/test-utils";
import LogPanel from "../src/components/LogPanel.vue";
import { logStore } from "../src/stores/log.js";

/**
 * 操作ログはエミュレーターのフッターに置き、**そのセッションの分だけ**出す。
 *
 * ws-client は sessionId にラベルを入れていたため、実 ID で絞ると 0 件になっていた。
 * 同名の設定を 2 本開けるので、絞り込みはラベルではなく実 ID で行う。
 */
function entry(sessionId: string, label: string, summary: string): void {
  logStore.add({ ts: 0, sessionId, label, dir: "tx", kind: "key", summary });
}

describe("操作ログの絞り込み", () => {
  beforeEach(() => {
    logStore.clear();
  });

  it("指定セッションの行だけ出す", () => {
    entry("id-1", "pub400", "F3");
    entry("id-2", "pub400", "Enter");
    entry("id-1", "pub400", "F5");

    const w = mount(LogPanel, { props: { sessionId: "id-1", open: true } });
    expect(w.findAll(".lg")).toHaveLength(2);
    expect(w.text()).not.toContain("Enter");
    w.unmount();
  });

  it("同名ラベルでもセッションを取り違えない", () => {
    entry("id-1", "pub400", "F3");
    entry("id-2", "pub400", "Enter");

    const w = mount(LogPanel, { props: { sessionId: "id-2", open: true } });
    expect(w.findAll(".lg")).toHaveLength(1);
    expect(w.text()).toContain("Enter");
    w.unmount();
  });

  it("sessionId 未指定なら全件（従来の全体表示）", () => {
    entry("id-1", "a", "F3");
    entry("id-2", "b", "Enter");

    const w = mount(LogPanel, { props: { open: true } });
    expect(w.findAll(".lg")).toHaveLength(2);
    w.unmount();
  });

  it("閉じているときは何も描画しない（画面を覆わない）", () => {
    entry("id-1", "a", "F3");
    const w = mount(LogPanel, { props: { sessionId: "id-1", open: false } });
    expect(w.find(".logpanel").exists()).toBe(false);
    w.unmount();
  });
});

describe("新しい行への追従", () => {
  /**
   * 最下部にいるときだけ追従する。過去を遡って読んでいる最中に飛ばされると、
   * 追っていた行を見失う。
   */
  function mountOpen() {
    return mount(LogPanel, { props: { sessionId: "id-1", open: true }, attachTo: document.body });
  }

  it("最下部にいれば新しい行へ追従する", async () => {
    const { nextTick } = await import("vue");
    for (let i = 0; i < 20; i++) entry("id-1", "a", `e${i}`);
    const w = mountOpen();
    await nextTick();

    const body = w.find(".body").element as HTMLElement;
    // jsdom は実寸を持たないので、最下部の状態を作って判定を通す
    Object.defineProperty(body, "scrollHeight", { value: 500, configurable: true });
    Object.defineProperty(body, "clientHeight", { value: 500, configurable: true });
    body.scrollTop = 0;

    entry("id-1", "a", "new");
    await nextTick();
    await nextTick();
    expect(body.scrollTop).toBe(500);
    w.unmount();
  });

  it("遡って読んでいるときは追従しない", async () => {
    const { nextTick } = await import("vue");
    for (let i = 0; i < 20; i++) entry("id-1", "a", `e${i}`);
    const w = mountOpen();
    await nextTick();

    const body = w.find(".body").element as HTMLElement;
    Object.defineProperty(body, "scrollHeight", { value: 1000, configurable: true });
    Object.defineProperty(body, "clientHeight", { value: 200, configurable: true });
    body.scrollTop = 100; // 上のほうを読んでいる

    entry("id-1", "a", "new");
    await nextTick();
    await nextTick();
    expect(body.scrollTop).toBe(100);
    w.unmount();
  });
});
