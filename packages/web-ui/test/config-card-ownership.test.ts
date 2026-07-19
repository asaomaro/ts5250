import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mount, flushPromises } from "@vue/test-utils";
import type { PublicSession, PublicSystem } from "@as400web/server";
import ConfigCard from "../src/components/ConfigCard.vue";
import LauncherPane from "../src/components/LauncherPane.vue";
import { authStore } from "../src/stores/auth.js";
import { systemsStore } from "../src/stores/systems.js";

/**
 * 保存先スコープ（サーバー設定 / 自分の設定）が UI にどう出るか。
 *
 * 旧 ConnectView の「所有ラベルの出し分け」を引き継ぐ検証。データモデル刷新後は
 * **参照の接頭辞（`srv:` / `own:`）だけがスコープの根拠**で、利用者の権限では変わらない。
 * 権限が効くのは「サーバー設定を編集・保存できるか（`editable`）」の一点だけ。
 */

const SRV_SYSTEM: PublicSystem = { ref: "srv:pub400", name: "pub400", host: "pub400.com", autoSignon: false };
const OWN_SYSTEM: PublicSystem = { ref: "own:s-1", name: "自分の環境", host: "h", autoSignon: false };

const calls: { url: string; method: string; body: string }[] = [];

function stubFetch(editable: boolean, systems: PublicSystem[], sessions: PublicSession[] = []): void {
  calls.length = 0;
  vi.stubGlobal("fetch", (url: string, init?: RequestInit) => {
    const u = String(url);
    const method = init?.method ?? "GET";
    calls.push({ url: u, method, body: String(init?.body ?? "") });
    if (u === "/api/systems" && method === "GET") {
      return Promise.resolve(new Response(JSON.stringify({ systems, editable }), { status: 200 }));
    }
    if (u === "/api/sessions-config" && method === "GET") {
      return Promise.resolve(new Response(JSON.stringify({ sessions }), { status: 200 }));
    }
    if (u === "/api/systems") {
      return Promise.resolve(new Response(JSON.stringify({ system: SRV_SYSTEM }), { status: 201 }));
    }
    return Promise.resolve(new Response("{}", { status: 200 }));
  });
}

beforeEach(() => {
  systemsStore.systems = [];
  systemsStore.sessions = [];
  systemsStore.selected = undefined;
  systemsStore.editable = false;
  systemsStore.loaded = false;
  authStore.enabled = false;
  authStore.user = undefined;
});
afterEach(() => vi.unstubAllGlobals());

describe("「サーバー設定」表記は保存先だけで決まる", () => {
  it("サーバー設定（srv:）のカードにだけ表記が出る", () => {
    const srv = mount(ConfigCard, { props: { kind: "system" as const, system: SRV_SYSTEM } });
    expect(srv.text()).toContain("サーバー設定");
    srv.unmount();

    const own = mount(ConfigCard, { props: { kind: "system" as const, system: OWN_SYSTEM } });
    expect(own.text()).not.toContain("サーバー設定");
    own.unmount();
  });

  it("利用者の権限では表記が変わらない（認証オン・admin でも srv: だけ）", () => {
    authStore.enabled = true;
    authStore.user = { username: "admin", role: "admin" };
    systemsStore.editable = true;
    const own = mount(ConfigCard, { props: { kind: "system" as const, system: OWN_SYSTEM } });
    expect(own.text()).not.toContain("サーバー設定");
    own.unmount();
  });
});

describe("所有（共有/個人）の語と移動 UI をどこにも出さない", () => {
  it("一覧にも編集フォームにも出さない（admin でも）", async () => {
    authStore.enabled = true;
    authStore.user = { username: "admin", role: "admin" };
    systemsStore.editable = true;
    stubFetch(true, [SRV_SYSTEM, OWN_SYSTEM]);
    const w = mount(LauncherPane);
    await flushPromises();
    expect(w.text()).not.toContain("共有");
    expect(w.text()).not.toContain("個人");

    // 既存カードの編集: 「共有にする / 個人にする」の移動ボタンが無い
    await w.findAll("button").find((b) => b.text() === "編集")!.trigger("click");
    await flushPromises();
    expect(w.text()).not.toContain("にする");
    expect(w.text()).not.toContain("共有");
    expect(w.text()).not.toContain("個人");
    // 保存先の移動は編集では選ばせない（作るときだけ決まる）
    expect(w.text()).not.toContain("保管場所");
    w.unmount();
  });
});

describe("信頼設定（サーバー側の出力）は保存先とセッション種別で出し分ける", () => {
  const printerSrv: PublicSession = { ref: "srv:p1", name: "prt", system: "srv:pub400", sessionType: "printer" };
  const printerOwn: PublicSession = { ref: "own:p1", name: "prt", system: "own:s-1", sessionType: "printer" };
  const displaySrv: PublicSession = { ref: "srv:d1", name: "disp", system: "srv:pub400", sessionType: "display" };

  async function openEdit(session: PublicSession) {
    const w = mount(ConfigCard, { props: { kind: "session" as const, session } });
    await w
      .findAll("button")
      .find((b) => b.text() === "編集")!
      .trigger("click");
    await flushPromises();
    return w;
  }

  it("サーバー設定のプリンターセッションで編集権限があるときだけ出る", async () => {
    systemsStore.editable = true;
    const w = await openEdit(printerSrv);
    expect(w.text()).toContain("PDF 保存先");
    w.unmount();
  });

  it("5250 表示では出ない", async () => {
    systemsStore.editable = true;
    const w = await openEdit(displaySrv);
    expect(w.text()).not.toContain("PDF 保存先");
    w.unmount();
  });

  it("自分の設定のプリンターには出ない（信頼境界）", async () => {
    systemsStore.editable = true;
    const w = await openEdit(printerOwn);
    expect(w.text()).not.toContain("PDF 保存先");
    w.unmount();
  });

  it("サーバー設定でも書き込めない構成（editable=false）ではそもそも編集に入れない", async () => {
    // 押しても 403 になるボタンは出さない。信頼設定へ至る入口ごと塞がれる
    systemsStore.editable = false;
    stubFetch(false, []);
    const w = mount(ConfigCard, { props: { kind: "session" as const, session: printerSrv } });
    await flushPromises();
    expect(w.findAll("button").some((b) => b.text() === "編集")).toBe(false);
    expect(w.text()).not.toContain("PDF 保存先");
    w.unmount();
  });

  it("既存セッションの種別は変更させない", async () => {
    systemsStore.editable = true;
    const w = await openEdit(displaySrv);
    const typeSelect = w.findAll("select").find((s) => s.text().includes("プリンター"))!;
    expect(typeSelect.attributes("disabled")).toBeDefined();
    w.unmount();
  });
});

describe("保管場所の選択は編集できる構成でだけ出す", () => {
  async function createSystem(editable: boolean) {
    stubFetch(editable, []);
    systemsStore.editable = editable;
    const w = mount(ConfigCard, { props: { kind: "system" as const, creating: true } });
    await flushPromises();
    return w;
  }

  async function fillAndSave(w: Awaited<ReturnType<typeof createSystem>>): Promise<void> {
    const inputs = w.findAll(".fgrid input");
    await inputs[0]!.setValue("n1"); // 名前
    await inputs[1]!.setValue("h1"); // ホスト
    await w
      .findAll("button")
      .find((b) => b.text() === "保存")!
      .trigger("click");
    await flushPromises();
  }

  it("editable=false では保管場所を選ばせず、自分の設定へ保存する", async () => {
    const w = await createSystem(false);
    expect(w.text()).not.toContain("保管場所");
    await fillAndSave(w);

    const post = calls.find((c) => c.url === "/api/systems" && c.method === "POST");
    expect(post).toBeDefined();
    expect((JSON.parse(post!.body) as { source: string }).source).toBe("personal");
    w.unmount();
  });

  it("editable=true では保管場所をサーバー設定にできる", async () => {
    const w = await createSystem(true);
    expect(w.text()).toContain("保管場所");
    await w.findAll("select")[0]!.setValue("server");
    await fillAndSave(w);

    const post = calls.find((c) => c.url === "/api/systems" && c.method === "POST");
    expect((JSON.parse(post!.body) as { source: string }).source).toBe("server");
    w.unmount();
  });
});
