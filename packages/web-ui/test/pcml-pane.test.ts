import { describe, it, expect, afterEach, vi } from "vitest";
import { mount, flushPromises } from "@vue/test-utils";
import PcmlPane from "../src/components/PcmlPane.vue";

/**
 * **PCML パネル。**
 *
 * ここで固定するのは「記述どおりに欄が並ぶこと」——構造体は入れ子、配列は件数ぶん。
 * 並びが記述と食い違うと、**送る値と見えている名前がずれる**。
 * 組み立てそのものはサーバーの仕事なので、ここでは**何を送ったか**までを見る。
 */
const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

/** 実機のコンパイラが吐いた形（`research.md` A の抜粋） */
const PARSED = {
  version: "6.0",
  programs: [
    {
      name: "PCMLTST",
      path: "/QSYS.LIB/TESTLIB.LIB/PCMLTST.PGM",
      fields: [
        { name: "INTXT", path: "PCMLTST.INTXT", type: "char", usage: "input", length: 10 },
        {
          name: "REC",
          path: "PCMLTST.REC",
          type: "struct",
          usage: "inputoutput",
          fields: [
            { name: "ID", path: "PCMLTST.REC.ID", type: "packed", usage: "inputoutput", length: 7, precision: 0 },
            { name: "NM", path: "PCMLTST.REC.NM", type: "char", usage: "inputoutput", length: 20 }
          ]
        },
        { name: "ITEMS", path: "PCMLTST.ITEMS", type: "char", usage: "inputoutput", length: 5, count: 3 },
        { name: "CNT", path: "PCMLTST.CNT", type: "int", usage: "output", length: 4, precision: 31 }
      ]
    }
  ]
};

function mockFetch(handler: (route: string, body: unknown) => { status?: number; body: unknown }) {
  const calls: { route: string; body: unknown }[] = [];
  globalThis.fetch = vi.fn(async (url: unknown, init?: RequestInit) => {
    const route = String(url).replace("/api/host/pcml/", "");
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ route, body });
    const r = handler(route, body);
    return new Response(JSON.stringify(r.body), {
      status: r.status ?? 200,
      headers: { "content-type": "application/json" }
    });
  }) as unknown as typeof fetch;
  return calls;
}

async function loaded(handler?: (route: string, body: unknown) => { status?: number; body: unknown }) {
  const calls = mockFetch(
    handler ?? ((route) => ({ body: route === "parse" ? PARSED : { success: true, returnCode: 0, messages: [], values: {} } }))
  );
  const w = mount(PcmlPane, { props: { tabId: "pcml:call", system: "srv:s" } });
  await w.find('[data-testid="pcml-path"]').setValue("/home/USER/pcmltst.pcml");
  await w.find('[data-testid="pcml-load"]').trigger("click");
  await flushPromises();
  return { w, calls };
}

describe("記述の読み込み", () => {
  it("**IFS の道で読む**（コンパイラが吐いた場所）", async () => {
    const { calls } = await loaded();
    expect(calls[0]?.route).toBe("parse");
    expect(calls[0]?.body).toMatchObject({ path: "/home/USER/pcmltst.pcml", source: { system: "srv:s" } });
  });

  it("貼り付けでも読める（接続が要らない）", async () => {
    const calls = mockFetch(() => ({ body: PARSED }));
    const w = mount(PcmlPane, { props: { tabId: "pcml:call", system: "srv:s" } });
    await w.findAll('input[type="radio"]')[1]!.setValue();
    await w.find('[data-testid="pcml-text"]').setValue("<pcml version=\"6.0\"></pcml>");
    await w.find('[data-testid="pcml-load"]').trigger("click");
    await flushPromises();
    expect(calls[0]?.body).toMatchObject({ text: '<pcml version="6.0"></pcml>' });
    expect((calls[0]?.body as { source?: unknown }).source).toBeUndefined();
  });

  it("読めなければ理由を出す", async () => {
    const { w } = await loaded((route) =>
      route === "parse" ? { status: 400, body: { error: "PCML 2 行目: <program> が閉じていません" } } : { body: {} }
    );
    expect(w.find('[data-testid="pcml-error"]').text()).toContain("2 行目");
  });
});

describe("欄の並び", () => {
  it("**構造体は入れ子で並ぶ**", async () => {
    const { w } = await loaded();
    const kwds = w.findAll("[data-kwd]").map((e) => e.attributes("data-kwd"));
    expect(kwds).toContain("PCMLTST.REC.ID");
    expect(kwds).toContain("PCMLTST.REC.NM");
  });

  it("**配列は件数ぶん並ぶ**（1 始まり）", async () => {
    const { w } = await loaded();
    const kwds = w.findAll("[data-kwd]").map((e) => e.attributes("data-kwd"));
    expect(kwds).toContain("PCMLTST.ITEMS(1)");
    expect(kwds).toContain("PCMLTST.ITEMS(3)");
    expect(kwds).not.toContain("PCMLTST.ITEMS(4)");
    expect(kwds).not.toContain("PCMLTST.ITEMS(0)");
  });

  it("**出力専用には入力欄を出さない**（ホストが書く場所）", async () => {
    const { w } = await loaded();
    const kwds = w.findAll("[data-kwd]").map((e) => e.attributes("data-kwd"));
    expect(kwds).not.toContain("PCMLTST.CNT");
    expect(w.text()).toContain("CNT");
  });

  it("型と長さを添える（桁が合っているか目で確かめられるように）", async () => {
    const { w } = await loaded();
    expect(w.text()).toContain("文字 10");
    expect(w.text()).toContain("詰め 10 進 7.0");
  });
});

describe("可変長の配列", () => {
  const VAR = {
    version: "4.0",
    programs: [
      {
        name: "LISTER",
        fields: [
          { name: "COUNT", path: "LISTER.COUNT", type: "int", usage: "inputoutput", length: 4, precision: 31 },
          { name: "NAMES", path: "LISTER.NAMES", type: "char", usage: "output", length: 8, count: "LISTER.COUNT" }
        ]
      }
    ]
  };

  it("**件数が決まるまでは並べない**（何行出すか分からない）", async () => {
    const { w } = await loaded((route) => ({ body: route === "parse" ? VAR : {} }));
    expect(w.text()).toContain("件数が LISTER.COUNT で決まります");
  });

  it("件数を入れると、その数だけ並ぶ", async () => {
    const { w } = await loaded((route) => ({ body: route === "parse" ? VAR : {} }));
    await w.find('[data-kwd="LISTER.COUNT"]').setValue("2");
    await flushPromises();
    const outs = w.findAll("[data-out]").map((e) => e.attributes("data-out"));
    expect(outs).toContain("LISTER.NAMES(1)");
    expect(outs).toContain("LISTER.NAMES(2)");
    expect(outs).not.toContain("LISTER.NAMES(3)");
  });
});

describe("呼ぶ", () => {
  it("**名前つきで送る**", async () => {
    const { w, calls } = await loaded();
    await w.find('[data-kwd="PCMLTST.INTXT"]').setValue("HELLO");
    await w.find('[data-testid="pcml-call"]').trigger("click");
    await flushPromises();
    const body = calls[1]?.body as { program: string; values: Record<string, string> };
    expect(calls[1]?.route).toBe("call");
    expect(body.program).toBe("PCMLTST");
    expect(body.values["PCMLTST.INTXT"]).toBe("HELLO");
  });

  it("**結果は項目の隣に出る**", async () => {
    const { w } = await loaded((route) =>
      route === "parse"
        ? { body: PARSED }
        : {
            body: {
              success: true,
              returnCode: 0,
              called: "TESTLIB/PCMLTST",
              messages: [],
              values: { "PCMLTST.REC.NM": "REC:HELLO", "PCMLTST.CNT": "3" }
            }
          }
    );
    await w.find('[data-testid="pcml-call"]').trigger("click");
    await flushPromises();
    expect(w.find('[data-out="PCMLTST.REC.NM"]').text()).toBe("REC:HELLO");
    expect(w.find('[data-out="PCMLTST.CNT"]').text()).toBe("3");
    expect(w.find('[data-testid="pcml-result"]').text()).toContain("TESTLIB/PCMLTST");
  });

  it("**サービスプログラムは呼ばせない**", async () => {
    const svc = {
      version: "4.0",
      programs: [{ name: "S", entrypoint: "PROC", fields: [] }]
    };
    const { w } = await loaded((route) => ({ body: route === "parse" ? svc : {} }));
    expect(w.text()).toContain("サービスプログラム");
    expect(w.find('[data-testid="pcml-call"]').attributes("disabled")).toBeDefined();
  });

  it("失敗はそのまま出す", async () => {
    const { w } = await loaded((route) =>
      route === "parse" ? { body: PARSED } : { status: 400, body: { error: "PCMLTST.REC.NM は inputoutput なので値が要ります" } }
    );
    await w.find('[data-testid="pcml-call"]').trigger("click");
    await flushPromises();
    expect(w.find('[data-testid="pcml-error"]').text()).toContain("PCMLTST.REC.NM");
  });
});
