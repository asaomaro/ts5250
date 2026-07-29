/**
 * 「無操作で切る」設定の UI 往復。
 *
 * **「サーバー既定に従う」と「切らない」は別の選択肢**にしてある。既定は切らないが、
 * 運用者が `--idle-timeout` で有限に変えている場合があり、ブラウザからは見えない。
 * したがって未設定のときは概要行を出さない（「切らない」と書くと嘘になりうる）。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mount, flushPromises } from "@vue/test-utils";
import type { PublicSession, PublicSystem } from "@as400web/server";
import ConfigCard from "../src/components/ConfigCard.vue";
import { authStore } from "../src/stores/auth.js";
import { systemsStore } from "../src/stores/systems.js";

const OWN_SYSTEM: PublicSystem = { ref: "own:s-1", name: "自分の環境", host: "h", autoSignon: false };
const calls: { url: string; method: string; body: string }[] = [];

function stubFetch(): void {
  calls.length = 0;
  vi.stubGlobal("fetch", (url: string, init?: RequestInit) => {
    const u = String(url);
    const method = init?.method ?? "GET";
    calls.push({ url: u, method, body: String(init?.body ?? "") });
    if (u === "/api/systems" && method === "GET") {
      return Promise.resolve(
        new Response(JSON.stringify({ systems: [OWN_SYSTEM], editable: true }), { status: 200 })
      );
    }
    if (u === "/api/sessions-config" && method === "GET") {
      return Promise.resolve(new Response(JSON.stringify({ sessions: [] }), { status: 200 }));
    }
    return Promise.resolve(new Response("{}", { status: 200 }));
  });
}

function session(idleTimeout?: "never" | number): PublicSession {
  return {
    ref: "own:c-1",
    name: "s",
    system: OWN_SYSTEM.ref,
    sessionType: "display",
    ...(idleTimeout !== undefined ? { idleTimeout } : {})
  };
}

beforeEach(() => {
  systemsStore.systems = [OWN_SYSTEM];
  systemsStore.sessions = [];
  systemsStore.editable = true;
  systemsStore.loaded = true;
  authStore.enabled = false;
  authStore.user = undefined;
  stubFetch();
});
afterEach(() => vi.unstubAllGlobals());

describe("概要表示（ⓘ の詳細）", () => {
  /** 詳細ポップオーバーを開いて本文を返す */
  async function info(current: PublicSession): Promise<string> {
    const w = mount(ConfigCard, { props: { kind: "session" as const, session: current } });
    await w.find("button.info").trigger("click");
    await flushPromises();
    const text = w.text();
    w.unmount();
    return text;
  }

  it("未設定なら行を出さない（サーバー既定はブラウザから見えない）", async () => {
    expect(await info(session())).not.toContain("無操作で切る");
  });

  it('"never" は「切らない」と出す', async () => {
    const text = await info(session("never"));
    expect(text).toContain("無操作で切る");
    expect(text).toContain("切らない");
  });

  it("分は「N 分」と出す", async () => {
    expect(await info(session(30))).toContain("30 分");
  });
});

describe("編集フォームの往復", () => {
  /** 「無操作で切る」の select を掴む（選択肢の文言で特定する） */
  function idleSelect(w: ReturnType<typeof mount>) {
    return w.findAll("select").find((s) => s.text().includes("サーバー既定に従う"))!;
  }

  async function saveWith(
    current: PublicSession,
    pick: (w: ReturnType<typeof mount>) => Promise<void>
  ): Promise<Record<string, unknown>> {
    const w = mount(ConfigCard, { props: { kind: "session" as const, session: current } });
    await w
      .findAll("button")
      .find((b) => b.text() === "編集")!
      .trigger("click");
    await flushPromises();
    await pick(w);
    await w
      .findAll("button")
      .find((b) => b.text() === "保存")!
      .trigger("click");
    await flushPromises();
    const put = calls.find((c) => c.url.startsWith("/api/sessions-config/") && c.method === "PUT");
    expect(put).toBeDefined();
    w.unmount();
    return JSON.parse(put!.body) as Record<string, unknown>;
  }

  it("既存の値がフォームに開く（編集していなくても保存で消えない）", async () => {
    const body = await saveWith(session(30), async () => {});
    expect(body.idleTimeout).toBe(30);
  });

  it("「切らない」を選べる", async () => {
    const body = await saveWith(session(), async (w) => {
      await idleSelect(w).setValue("never");
    });
    expect(body.idleTimeout).toBe("never");
  });

  it("分を選べる（数値で送る）", async () => {
    const body = await saveWith(session(), async (w) => {
      await idleSelect(w).setValue(60);
    });
    expect(body.idleTimeout).toBe(60);
  });

  it("「サーバー既定に従う」はキーごと送らない（既定値を設定ファイルに書き散らさない）", async () => {
    const body = await saveWith(session(30), async (w) => {
      await idleSelect(w).setValue(undefined);
    });
    expect("idleTimeout" in body).toBe(false);
  });
});

/**
 * 設定ファイルへ直接書かれた値（1〜1440 の任意）が選択肢に無いとき。
 * **足さないと select が空欄になり「設定されていない」ように見える**——値は保持されるので、
 * 黙って消えるより分かりにくい。
 */
describe("一覧に無い分数", () => {
  it("現在値を選択肢へ足して選択状態にする", async () => {
    const w = mount(ConfigCard, { props: { kind: "session" as const, session: session(1) } });
    await w
      .findAll("button")
      .find((b) => b.text() === "編集")!
      .trigger("click");
    await flushPromises();
    const sel = w.findAll("select").find((s) => s.text().includes("サーバー既定に従う"))!;
    expect(sel.text()).toContain("1 分");
    expect((sel.element as HTMLSelectElement).value).not.toBe("");
    w.unmount();
  });

  it("一覧にある値では選択肢を増やさない", async () => {
    const w = mount(ConfigCard, { props: { kind: "session" as const, session: session(30) } });
    await w
      .findAll("button")
      .find((b) => b.text() === "編集")!
      .trigger("click");
    await flushPromises();
    const sel = w.findAll("select").find((s) => s.text().includes("サーバー既定に従う"))!;
    expect(sel.findAll("option")).toHaveLength(2 + 7); // 既定 + 切らない + IDLE_MINUTES
    w.unmount();
  });
});
