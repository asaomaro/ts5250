/**
 * ACS の「ホスト・コード・ページ」一覧と同じ 1 本の選択肢の UI 往復
 * （`20260922-katakana-variant-setting`・`20260922-katakana-selector-merge`）。
 * 930 の Katakana / Katakana Extended は独立した設定項目に分けず、CCSID の選択肢そのものに
 * 2 エントリとして吸収されている（ACS の接続設定画面と同じ形）。
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

/** 「拡張カタカナ」の選択肢を持つ ── ホストコードページの選択（システム/セッションどちらも 1 本だけ） */
function codePageSelect(w: ReturnType<typeof mount>) {
  return w.findAll("select").find((s) => s.text().includes("拡張カタカナ"))!;
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
  it("**930 は Katakana／Katakana Extended の 2 エントリを持つ選択肢が常に出る**（独立した項目には分けない）", async () => {
    const w = mount(ConfigCard, { props: { kind: "system" as const, system: SYSTEM_930 } });
    await openEdit(w);
    expect(codePageSelect(w).text()).toContain("日本語（カタカナ）");
    expect(codePageSelect(w).text()).toContain("日本（拡張カタカナ）");
    w.unmount();
  });

  it("既存の \"katakana\" 選択がフォームに開き、選び直すと ccsid・katakanaVariant が両方更新される", async () => {
    const w = mount(ConfigCard, { props: { kind: "system" as const, system: { ...SYSTEM_930, katakanaVariant: "katakana" } } });
    await openEdit(w);
    const sel = codePageSelect(w);
    expect((sel.element as HTMLSelectElement).value).toBe("930-katakana");
    await sel.setValue("930-katakana-ex");
    const body = await save(w, "/api/systems/");
    expect(body.ccsid).toBe(930);
    expect(body.katakanaVariant).toBe("katakana-ex");
    w.unmount();
  });

  it("**未指定（既定）は \"930 — 日本（拡張カタカナ）\" として開く**が、選び直さなければ katakanaVariant は送らない", async () => {
    const w = mount(ConfigCard, { props: { kind: "system" as const, system: SYSTEM_930 } });
    await openEdit(w);
    const sel = codePageSelect(w);
    expect((sel.element as HTMLSelectElement).value).toBe("930-katakana-ex");
    const body = await save(w, "/api/systems/");
    expect("katakanaVariant" in body).toBe(false);
    w.unmount();
  });

  it("930 系から 37 に選び直すと katakanaVariant が外れる", async () => {
    const w = mount(ConfigCard, { props: { kind: "system" as const, system: { ...SYSTEM_930, katakanaVariant: "katakana" } } });
    await openEdit(w);
    await codePageSelect(w).setValue("37");
    const body = await save(w, "/api/systems/");
    expect(body.ccsid).toBe(37);
    expect("katakanaVariant" in body).toBe(false);
    w.unmount();
  });
});

describe("セッション設定", () => {
  it("**「システムの既定」を選ぶと ccsid・katakanaVariant のどちらも送らない**（システムの値を上書きしない）", async () => {
    const w = mount(ConfigCard, { props: { kind: "session" as const, session: session({ ccsid: 930, katakanaVariant: "katakana" }) } });
    await openEdit(w);
    const sel = codePageSelect(w);
    expect((sel.element as HTMLSelectElement).value).toBe("930-katakana");
    await sel.setValue("inherit");
    const body = await save(w, "/api/sessions-config/");
    expect("ccsid" in body).toBe(false);
    expect("katakanaVariant" in body).toBe(false);
    w.unmount();
  });

  it("ccsid 未指定（親のみ 930）は「システムの既定」として開く", async () => {
    const w = mount(ConfigCard, { props: { kind: "session" as const, session: session() } }); // ccsid 未指定・親は 930
    await openEdit(w);
    expect((codePageSelect(w).element as HTMLSelectElement).value).toBe("inherit");
    w.unmount();
  });

  it("既存の \"katakana-ex\" 選択がフォームに開き、選び直して保存できる", async () => {
    const w = mount(ConfigCard, { props: { kind: "session" as const, session: session({ ccsid: 930, katakanaVariant: "katakana-ex" }) } });
    await openEdit(w);
    const sel = codePageSelect(w);
    expect((sel.element as HTMLSelectElement).value).toBe("930-katakana-ex");
    await sel.setValue("930-katakana");
    const body = await save(w, "/api/sessions-config/");
    expect(body.ccsid).toBe(930);
    expect(body.katakanaVariant).toBe("katakana");
    w.unmount();
  });
});
