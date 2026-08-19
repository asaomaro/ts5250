import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mount, flushPromises } from "@vue/test-utils";
import CommandPane from "../src/components/CommandPane.vue";

/**
 * **CL コマンドのプロンプト**（実機の F4 に当たる画面）。
 *
 * 見るのは「定義どおりに欄が並ぶか」——説明・必須の印・選べる値・既定値。
 * **引用と検証はサーバー**なので、ここでは**値の入れ物としての正しさ**だけを固定する。
 */
const CRTLIB = {
  name: "CRTLIB",
  library: "QSYS",
  prompt: "Create Library",
  maxPositional: 2,
  parameters: [
    {
      keyword: "LIB", type: "NAME", required: true, maxValues: 1, length: 10,
      restricted: false, prompt: "Library", specialValues: []
    },
    {
      keyword: "TYPE", type: "NAME", required: false, maxValues: 1, length: 10,
      restricted: true, default: "*PROD", prompt: "Library type",
      specialValues: ["*PROD", "*TEST"]
    },
    {
      keyword: "TEXT", type: "CHAR", required: false, maxValues: 1, length: 50,
      restricted: false, default: "*BLANK", prompt: "Text description", specialValues: []
    },
    // 入れ子（この画面では扱えない）
    { keyword: "NESTED", type: "ELEM", required: false, maxValues: 1, restricted: false, specialValues: [] }
  ]
};

const fetchMock = vi.fn();
beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

const reply = (body: unknown, ok = true): Promise<Response> =>
  Promise.resolve({ ok, json: () => Promise.resolve(body) } as Response);

async function mounted() {
  fetchMock.mockReturnValueOnce(reply(CRTLIB));
  const w = mount(CommandPane, { props: { tabId: "cmd:prompt", system: "srv:s" } });
  await w.find("button").trigger("click"); // 「引く」
  await flushPromises();
  return w;
}

describe("コマンド入力支援", () => {
  it("**定義どおりに欄が並ぶ**（説明つき）", async () => {
    const w = await mounted();
    expect(w.text()).toContain("Create Library");
    expect(w.text()).toContain("Library type");
    expect(w.findAll("tbody tr")).toHaveLength(3); // ELEM は出さない
  });

  it("**決まった値しか受けない欄は選択肢になる**", async () => {
    const w = await mounted();
    const sel = w.find('select[data-kwd="TYPE"]');
    expect(sel.exists()).toBe(true);
    const opts = sel.findAll("option").map((o) => o.text());
    // **空の選択肢（既定に任せる）を必ず置く**
    expect(opts[0]).toContain("既定");
    expect(opts).toContain("*PROD");
    expect(opts).toContain("*TEST");
    // 制限の無い欄は素の入力
    expect(w.find('input[data-kwd="LIB"]').exists()).toBe(true);
  });

  it("**既定値は欄に入れない**——空欄＝ホストの既定（CL の作法）", async () => {
    const w = await mounted();
    expect((w.find('input[data-kwd="TEXT"]').element as HTMLInputElement).value).toBe("");
    expect(w.text()).toContain("既定 *BLANK"); // 脇には出す
  });

  it("**必須が空なら実行させない**", async () => {
    const w = await mounted();
    const run = w.findAll("button").find((b) => b.text() === "実行")!;
    expect(run.attributes("disabled")).toBeDefined();
    expect(w.text()).toContain("必須が空です: LIB");

    await w.find('input[data-kwd="LIB"]').setValue("ASAOLIB");
    expect(w.findAll("button").find((b) => b.text() === "実行")!.attributes("disabled")).toBeUndefined();
  });

  it("**組み上がりが見える**", async () => {
    const w = await mounted();
    await w.find('input[data-kwd="LIB"]').setValue("ASAOLIB");
    await w.find('input[data-kwd="TEXT"]').setValue("a b");
    expect(w.find('[data-testid="preview"]').text()).toBe("CRTLIB LIB(ASAOLIB) TEXT(a b)");
  });

  it("**「確かめる」でサーバーが組んだ文字列に差し替わる**", async () => {
    const w = await mounted();
    await w.find('input[data-kwd="LIB"]').setValue("ASAOLIB");
    await w.find('input[data-kwd="TEXT"]').setValue("It's a test");
    // 下書きは引用を付けない（規則を画面に写していないため）
    expect(w.find('[data-testid="preview"]').text()).toContain("TEXT(It's a test)");

    fetchMock.mockReturnValueOnce(reply({ command: "CRTLIB LIB(ASAOLIB) TEXT('It''s a test')" }));
    await w.findAll("button").find((b) => b.text() === "確かめる")!.trigger("click");
    await flushPromises();
    expect(w.find('[data-testid="preview"]').text()).toContain("TEXT('It''s a test')");
    expect(w.text()).toContain("サーバーが組んだ文字列");
  });

  it("**値を触ると確かめた文字列は消える**（古い文字列を見せない）", async () => {
    const w = await mounted();
    await w.find('input[data-kwd="LIB"]').setValue("A");
    fetchMock.mockReturnValueOnce(reply({ command: "CRTLIB LIB(A)" }));
    await w.findAll("button").find((b) => b.text() === "確かめる")!.trigger("click");
    await flushPromises();
    expect(w.text()).toContain("サーバーが組んだ文字列");

    await w.find('input[data-kwd="TEXT"]').setValue("x");
    expect(w.text()).not.toContain("サーバーが組んだ文字列");
  });

  it("**扱えないパラメータは名前を挙げる**（黙って落とさない）", async () => {
    const w = await mounted();
    expect(w.text()).toContain("扱えないパラメータ");
    expect(w.text()).toContain("NESTED");
  });

  it("**実行すると走った文字列とメッセージを出す**", async () => {
    const w = await mounted();
    await w.find('input[data-kwd="LIB"]').setValue("ASAOLIB");
    fetchMock.mockReturnValueOnce(
      reply({
        command: "CRTLIB LIB(ASAOLIB)",
        success: true,
        returnCode: 0,
        messages: [{ id: "CPC2102", text: "ライブラリー ASAOLIB が作成された。" }]
      })
    );
    await w.findAll("button").find((b) => b.text() === "実行")!.trigger("click");
    await flushPromises();
    // **走った文字列はサーバーの応答から出す**（画面の下書きではなく）
    expect(w.find('[data-testid="ran"]').text()).toBe("CRTLIB LIB(ASAOLIB)");
    expect(w.text()).toContain("CPC2102");
    expect(w.text()).toContain("成功");
  });

  it("**サーバーのエラーをそのまま見せる**（打つ前に弾かれた理由が分かる）", async () => {
    const w = await mounted();
    await w.find('input[data-kwd="LIB"]').setValue("X");
    fetchMock.mockReturnValueOnce(reply({ error: "TYPE accepts only *PROD / *TEST", code: "FIELD_TYPE" }, false));
    await w.findAll("button").find((b) => b.text() === "実行")!.trigger("click");
    await flushPromises();
    expect(w.text()).toContain("FIELD_TYPE");
    expect(w.text()).toContain("accepts only");
  });
});
