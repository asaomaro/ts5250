import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mount, flushPromises } from "@vue/test-utils";
import ConnectView from "../src/components/ConnectView.vue";
import { authStore } from "../src/stores/auth.js";
import { connectionsStore } from "../src/stores/connections.js";

const PROFILES = [
  { name: "disp", host: "h", autoSignon: false, sessionType: "display" },
  { name: "prt", host: "h", autoSignon: false, sessionType: "printer" }
];

function stubFetch(editable: boolean): void {
  vi.stubGlobal("fetch", (url: string) => {
    const u = String(url);
    if (u.startsWith("/api/profiles")) {
      return Promise.resolve(new Response(JSON.stringify({ profiles: PROFILES, editable }), { status: 200 }));
    }
    if (u.startsWith("/api/connections")) {
      return Promise.resolve(new Response(JSON.stringify({ connections: [] }), { status: 200 }));
    }
    return Promise.resolve(new Response("{}", { status: 200 }));
  });
}

async function mountView() {
  const w = mount(ConnectView);
  await flushPromises();
  return w;
}

describe("ConnectView: 所有ラベルの出し分けと種別による printer 欄", () => {
  beforeEach(() => {
    connectionsStore.connections = [];
    authStore.enabled = false;
    authStore.user = undefined;
  });
  afterEach(() => vi.unstubAllGlobals());

  it("認証オフでは所有ラベル（共有/個人）を出さない", async () => {
    stubFetch(true);
    const w = await mountView();
    expect(w.text()).not.toContain("共有");
    expect(w.text()).not.toContain("個人");
    w.unmount();
  });

  it("認証オン（admin）では共有ラベルを出す", async () => {
    authStore.enabled = true;
    authStore.user = { username: "admin", role: "admin" };
    stubFetch(true);
    const w = await mountView();
    expect(w.text()).toContain("共有");
    w.unmount();
  });

  it("プリンター種別の編集でだけ PDF 出力設定が出る（5250端末では出ない）", async () => {
    stubFetch(true);
    const w = await mountView();
    const editButtons = w.findAll('button[title="編集"]');
    expect(editButtons.length).toBe(2); // disp / prt

    // 1件目 = disp（5250端末）→ printer 欄なし
    await editButtons[0]!.trigger("click");
    await flushPromises();
    expect(w.text()).not.toContain("PDF 自動蓄積");
    // 種別は変更不可の表示になる
    expect(w.text()).toContain("種別は変更できません");

    // 2件目 = prt（プリンター）→ printer 欄あり（再描画後に取り直す）
    await w.findAll('button[title="編集"]')[1]!.trigger("click");
    await flushPromises();
    expect(w.text()).toContain("PDF 自動蓄積");
    w.unmount();
  });
});
