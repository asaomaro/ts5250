import { describe, it, expect, beforeEach } from "vitest";
import { mount } from "@vue/test-utils";
import App from "../src/App.vue";
import { workspaceStore } from "../src/stores/workspace.js";
import { sessionsStore } from "../src/stores/sessions.js";

/**
 * Alt 系のグローバルショートカット（タブ切替・ペイン移動）は、5250 エミュレーターだけでなく
 * プリンターセッション・管理タブでも効く必要がある。セッション有無で判定していたため、
 * 管理タブしか開いていないとブラウザ既定動作（Alt+← の戻る等）に流れていた。
 */
function altKey(key: string): KeyboardEvent {
  return new KeyboardEvent("keydown", { key, altKey: true, bubbles: true, cancelable: true });
}

function reset(): void {
  sessionsStore.byId.clear();
  sessionsStore.order = [];
  workspaceStore.init();
}

describe("グローバルショートカット（Alt+PageUp/Down・Alt+矢印）", () => {
  beforeEach(reset);

  it("管理タブだけでも Alt+PageDown でタブが切り替わる（セッション不要）", () => {
    const w = mount(App);
    const g = workspaceStore.focusedGroup();
    g.tabs.push("admin:users", "admin:logs");
    g.activeTab = "admin:users";

    window.dispatchEvent(altKey("PageDown"));
    expect(workspaceStore.focusedGroup().activeTab).toBe("admin:logs");

    window.dispatchEvent(altKey("PageUp"));
    expect(workspaceStore.focusedGroup().activeTab).toBe("admin:users");
    w.unmount();
  });

  it("管理タブだけでも Alt+矢印はブラウザ既定動作を止める（戻る/進むへ流さない）", () => {
    const w = mount(App);
    const g = workspaceStore.focusedGroup();
    g.tabs.push("admin:users");
    g.activeTab = "admin:users";

    const ev = altKey("ArrowLeft");
    window.dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(true);
    w.unmount();
  });

  it("タブが 1 つも無ければ介入しない（接続画面でブラウザ既定を奪わない）", () => {
    const w = mount(App);
    const ev = altKey("ArrowLeft");
    window.dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(false);
    w.unmount();
  });
});
