import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mount, flushPromises } from "@vue/test-utils";
import AccountPopover from "../src/components/AccountPopover.vue";
import { authStore } from "../src/stores/auth.js";

/**
 * トークンはユーザーの資格情報なのでアカウント画面に置く（接続の編集画面ではない）。
 * 再発行で以前が失効するため、警告は発行「前」に出ている必要がある。
 */
function stubFetch(token = "a".repeat(48)): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({ ok: true, status: 201, json: async () => ({ token }) }))
  );
}

describe("AccountPopover（API トークン）", () => {
  beforeEach(() => {
    authStore.enabled = true;
    authStore.user = { username: "alice", role: "user" };
    authStore.hasToken = false;
  });
  afterEach(() => vi.unstubAllGlobals());

  it("発行前から失効の警告を出す（押した後では遅いため）", () => {
    const w = mount(AccountPopover);
    expect(w.text()).toContain("以前のトークンは使えなくなります");
    w.unmount();
  });

  it("未発行なら「発行する」、発行済みなら「再発行する」と出る", async () => {
    let w = mount(AccountPopover);
    expect(w.text()).toContain("発行する");
    expect(w.text()).toContain("未発行");
    w.unmount();

    authStore.hasToken = true;
    w = mount(AccountPopover);
    expect(w.text()).toContain("再発行する");
    expect(w.text()).toContain("発行済み");
    w.unmount();
  });

  it("発行すると平文が 1 回だけ表示され、再表示できない旨を伝える", async () => {
    stubFetch();
    const w = mount(AccountPopover);
    await w.find("button.ghost").trigger("click");
    await flushPromises();
    expect(w.text()).toContain("a".repeat(48));
    expect(w.text()).toContain("二度と表示できません");
    expect(authStore.hasToken).toBe(true);
    w.unmount();
  });

  it("発行前は平文を表示しない", () => {
    const w = mount(AccountPopover);
    expect(w.text()).not.toMatch(/[0-9a-f]{48}/);
    w.unmount();
  });

  it("失敗すると理由を表示する", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: false, status: 401, json: async () => ({ error: "unauthorized" }) }))
    );
    const w = mount(AccountPopover);
    await w.find("button.ghost").trigger("click");
    await flushPromises();
    expect(w.text()).toContain("unauthorized");
    w.unmount();
  });
});
