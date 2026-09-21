/**
 * **関連付けプリンター**の UI 往復（`20260921-associated-printer`）。
 *
 * 5250 の表示セッションだけが持つ（ホストへ IBMASSOCPRT として申告する。サーバーは他の種別に書くと 400）。
 * 送るかどうかは ACS と同じく Java の `trim()` で空かを見て、値は打ったまま送る（ACS は空白も大文字小文字も加工しない）。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mount, flushPromises, type VueWrapper } from "@vue/test-utils";
import type { PublicSession, PublicSystem } from "@ts5250/server";
import ConfigCard from "../src/components/ConfigCard.vue";
import { authStore } from "../src/stores/auth.js";
import { systemsStore } from "../src/stores/systems.js";

const OWN_SYSTEM: PublicSystem = { ref: "own:s-1", name: "自分の環境", host: "h", autoSignon: false };
const calls: { url: string; method: string; body: string }[] = [];

beforeEach(() => {
  systemsStore.systems = [OWN_SYSTEM];
  systemsStore.sessions = [];
  systemsStore.editable = true;
  systemsStore.loaded = true;
  authStore.enabled = false;
  authStore.user = undefined;
  calls.length = 0;
  vi.stubGlobal("fetch", (url: string, init?: RequestInit) => {
    calls.push({ url: String(url), method: init?.method ?? "GET", body: String(init?.body ?? "") });
    if (url === "/api/systems") return Promise.resolve(new Response(JSON.stringify({ systems: [OWN_SYSTEM], editable: true })));
    if (url === "/api/sessions-config") return Promise.resolve(new Response(JSON.stringify({ sessions: [] })));
    return Promise.resolve(new Response("{}"));
  });
});
afterEach(() => vi.unstubAllGlobals());

const session = (over: Partial<PublicSession> = {}): PublicSession => ({
  ref: "own:c-1",
  name: "s",
  system: OWN_SYSTEM.ref,
  sessionType: "display",
  ...over
});

async function openEdit(current: PublicSession): Promise<VueWrapper> {
  const w = mount(ConfigCard, { props: { kind: "session" as const, session: current } });
  await w.findAll("button").find((b) => b.text() === "編集")!.trigger("click");
  await flushPromises();
  return w;
}
const assocInput = (w: VueWrapper) => w.findAll("label.row").find((l) => l.text().includes("関連付けプリンター"))?.find("input");

async function save(w: VueWrapper): Promise<Record<string, unknown>> {
  await w.findAll("button").find((b) => b.text() === "保存")!.trigger("click");
  await flushPromises();
  const put = calls.find((c) => c.url.startsWith("/api/sessions-config/") && c.method === "PUT");
  expect(put).toBeDefined();
  w.unmount();
  return JSON.parse(put!.body) as Record<string, unknown>;
}

describe("関連付けプリンター", () => {
  it("既存の値が欄に開き、編集しなくても保存で消えない", async () => {
    const w = await openEdit(session({ associatedPrinter: "PRT01" }));
    expect((assocInput(w)!.element as HTMLInputElement).value).toBe("PRT01");
    expect((await save(w)).associatedPrinter).toBe("PRT01");
  });

  it("**打ったまま送る**（空白も小文字も加工しない。ACS と同じ）", async () => {
    const w = await openEdit(session());
    await assocInput(w)!.setValue(" prt01");
    expect((await save(w)).associatedPrinter).toBe(" prt01");
  });

  it("空・空白だけなら送らない（キーごと消す）", async () => {
    for (const v of ["", "   "]) {
      const w = await openEdit(session({ associatedPrinter: "PRT01" }));
      await assocInput(w)!.setValue(v);
      expect(await save(w), JSON.stringify(v)).not.toHaveProperty("associatedPrinter");
      calls.length = 0;
    }
  });

  it("詳細（ⓘ）に出す。書いていなければ行を出さない", async () => {
    const info = async (over: Partial<PublicSession>): Promise<string> => {
      const w = mount(ConfigCard, { props: { kind: "session" as const, session: session(over) } });
      await w.find("button.info").trigger("click");
      await flushPromises();
      const text = w.text();
      w.unmount();
      return text;
    };
    expect(await info({ associatedPrinter: "PRT01" })).toContain("関連付けプリンターPRT01");
    expect(await info({})).not.toContain("関連付けプリンター");
  });

  it("**5250 の表示だけに欄を出す**（プリンター・3270 には出さない）", async () => {
    for (const over of [{ sessionType: "printer" as const }, { terminal: "3270" as const }]) {
      const w = await openEdit(session(over));
      expect(assocInput(w), JSON.stringify(over)).toBeUndefined();
      w.unmount();
    }
  });

  it("**3270 に切り替えたら送らない**（サーバーは 400 にする）", async () => {
    const w = await openEdit(session({ associatedPrinter: "PRT01" }));
    await w.findAll("select").find((s) => s.text().includes("3270"))!.setValue("3270");
    expect(await save(w)).not.toHaveProperty("associatedPrinter");
  });
});
