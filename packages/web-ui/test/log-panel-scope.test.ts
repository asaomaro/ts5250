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
