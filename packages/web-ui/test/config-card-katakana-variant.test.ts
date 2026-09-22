/**
 * 930/5026（Katakana 系）だけが持つ「カタカナのキー配列」の UI 往復（`20260922-katakana-variant-setting`）。
 * ACS 自身が「ホスト・コード・ページ」の設定で利用者ごとに選ばせる軸なので、当 PJ も選ばせる。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mount, flushPromises } from "@vue/test-utils";
import type { PublicSession, PublicSystem } from "@ts5250/server";
import ConfigCard from "../src/components/ConfigCard.vue";
import { authStore } from "../src/stores/auth.js";
import { systemsStore } from "../src/stores/systems.js";

const SYSTEM_930: PublicSystem = { ref: "own:s-1", name: "930 環境", host: "h", ccsid: 930, autoSignon: false };
const SYSTEM_37: PublicSystem = { ref: "own:s-2", name: "37 環境", host: "h2", ccsid: 37, autoSignon: false };
const calls: { url: string; method: string; body: string }[] = [];

function stubFetch(systems: PublicSystem[]): void {
  calls.length = 0;
  vi.stubGlobal("fetch", (url: string, init?: RequestInit) => {
    const u = String(url);
    const method = init?.method ?? "GET";
    calls.push({ url: u, method, body: String(init?.body ?? "") });
    if (u === "/api/systems" && method === "GET") {
      return Promise.resolve(new Response(JSON.stringify({ systems, editable: true }), { status: 200 }));
    }
    if (u === "/api/sessions-config" && method === "GET") {
      return Promise.resolve(new Response(JSON.stringify({ sessions: [] }), { status: 200 }));
    }
    return Promise.resolve(new Response("{}", { status: 200 }));
  });
}

function session(over: Partial<PublicSession> = {}): PublicSession {
  return { ref: "own:c-1", name: "s", system: SYSTEM_930.ref, sessionType: "display", ...over };
}

beforeEach(() => {
  systemsStore.systems = [SYSTEM_930, SYSTEM_37];
  systemsStore.sessions = [];
  systemsStore.editable = true;
  systemsStore.loaded = true;
  authStore.enabled = false;
  authStore.user = undefined;
  stubFetch([SYSTEM_930, SYSTEM_37]);
});
afterEach(() => vi.unstubAllGlobals());

function katakanaSelect(w: ReturnType<typeof mount>) {
  return w.findAll("select").find((s) => s.text().includes("Katakana Extended"));
}

async function openEdit(w: ReturnType<typeof mount>): Promise<void> {
  await w
    .findAll("button")
    .find((b) => b.text() === "編集")!
    .trigger("click");
  await flushPromises();
}

async function save(w: ReturnType<typeof mount>, url: string): Promise<Record<string, unknown>> {
  await w
    .findAll("button")
    .find((b) => b.text() === "保存")!
    .trigger("click");
  await flushPromises();
  const put = calls.find((c) => c.url.startsWith(url) && c.method === "PUT");
  expect(put, `${url} への PUT が送られている`).toBeDefined();
  return JSON.parse(put!.body) as Record<string, unknown>;
}

describe("システム設定", () => {
  it("**CCSID が 930/5026 のときだけ選択肢が出る**", async () => {
    const w930 = mount(ConfigCard, { props: { kind: "system" as const, system: SYSTEM_930 } });
    await openEdit(w930);
    expect(katakanaSelect(w930), "930 では出る").toBeDefined();
    w930.unmount();

    const w37 = mount(ConfigCard, { props: { kind: "system" as const, system: SYSTEM_37 } });
    await openEdit(w37);
    expect(katakanaSelect(w37), "37 では出ない").toBeUndefined();
    w37.unmount();
  });

  it("既存の値がフォームに開き、選び直して保存できる", async () => {
    const w = mount(ConfigCard, { props: { kind: "system" as const, system: { ...SYSTEM_930, katakanaVariant: "katakana" } } });
    await openEdit(w);
    const sel = katakanaSelect(w)!;
    expect((sel.element as HTMLSelectElement).value).toBe("katakana");
    await sel.setValue("katakana-ex");
    const body = await save(w, "/api/systems/");
    expect(body.katakanaVariant).toBe("katakana-ex");
    w.unmount();
  });

  it("未設定（既定）のまま保存すると katakanaVariant を送らない", async () => {
    const w = mount(ConfigCard, { props: { kind: "system" as const, system: SYSTEM_930 } });
    await openEdit(w);
    const body = await save(w, "/api/systems/");
    expect("katakanaVariant" in body).toBe(false);
    w.unmount();
  });
});

describe("セッション設定", () => {
  it("**セッションの CCSID 未指定でも、親システムが 930/5026 なら選択肢が出る**", async () => {
    const w = mount(ConfigCard, { props: { kind: "session" as const, session: session() } }); // ccsid 未指定・親は 930
    await openEdit(w);
    expect(katakanaSelect(w)).toBeDefined();
    w.unmount();
  });

  it("セッション側で CCSID を 37 に上書きすると選択肢が消える", async () => {
    const w = mount(ConfigCard, { props: { kind: "session" as const, session: session({ ccsid: 37 }) } });
    await openEdit(w);
    expect(katakanaSelect(w)).toBeUndefined();
    w.unmount();
  });

  it("既存の値がフォームに開き、選び直して保存できる", async () => {
    const w = mount(ConfigCard, { props: { kind: "session" as const, session: session({ katakanaVariant: "katakana-ex" }) } });
    await openEdit(w);
    const sel = katakanaSelect(w)!;
    expect((sel.element as HTMLSelectElement).value).toBe("katakana-ex");
    await sel.setValue("katakana");
    const body = await save(w, "/api/sessions-config/");
    expect(body.katakanaVariant).toBe("katakana");
    w.unmount();
  });

  it("**「システムの既定」を選ぶと katakanaVariant を送らない**（システムの値を上書きしない）", async () => {
    const w = mount(ConfigCard, { props: { kind: "session" as const, session: session({ katakanaVariant: "katakana" }) } });
    await openEdit(w);
    const sel = katakanaSelect(w)!;
    await sel.setValue(undefined as unknown as string);
    const body = await save(w, "/api/sessions-config/");
    expect("katakanaVariant" in body).toBe(false);
    w.unmount();
  });
});
