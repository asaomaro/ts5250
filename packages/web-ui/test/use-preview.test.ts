import { describe, it, expect, afterEach, vi } from "vitest";
import { defineComponent, h } from "vue";
import { mount } from "@vue/test-utils";
import { usePreview, kindOf } from "../src/composables/usePreview.js";

/**
 * プレビュー。見たいのは 2 つ:
 *
 * - **blob URL をいつ解放するか**。既存の `PrinterPane.vue` は `click()` 直後に解放しており、
 *   そのままプレビューに転用すると表示前に消える
 * - **復号できないテキストをエラー扱いしないこと**。読み取りは成功していて表示手段が無いだけ
 */
const realFetch = globalThis.fetch;
const realCreate = URL.createObjectURL;
const realRevoke = URL.revokeObjectURL;

afterEach(() => {
  globalThis.fetch = realFetch;
  URL.createObjectURL = realCreate;
  URL.revokeObjectURL = realRevoke;
});

/** composable を実際にマウントして使う（onBeforeUnmount を働かせるため） */
function harness() {
  let api: ReturnType<typeof usePreview> | undefined;
  const wrapper = mount(
    defineComponent({
      setup() {
        api = usePreview(() => ({ system: "srv:s" }));
        return () => h("div");
      }
    })
  );
  return { wrapper, api: api as ReturnType<typeof usePreview> };
}

function mockJson(body: unknown, status = 200) {
  globalThis.fetch = vi.fn(async () =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" }
    })
  ) as unknown as typeof fetch;
}

function mockBlob() {
  globalThis.fetch = vi.fn(async () =>
    new Response(new Uint8Array([1, 2, 3]), { status: 200 })
  ) as unknown as typeof fetch;
}

/** 生成された URL と解放された URL を記録する */
function trackUrls() {
  const created: string[] = [];
  const revoked: string[] = [];
  let n = 0;
  URL.createObjectURL = vi.fn(() => {
    const url = `blob:test-${n++}`;
    created.push(url);
    return url;
  }) as unknown as typeof URL.createObjectURL;
  URL.revokeObjectURL = vi.fn((url: string) => {
    revoked.push(url);
  }) as unknown as typeof URL.revokeObjectURL;
  return { created, revoked };
}

describe("種別の振り分け", () => {
  it("拡張子で決める", () => {
    expect(kindOf("/a/b.pdf")).toBe("pdf");
    expect(kindOf("/a/b.PNG")).toBe("image");
    expect(kindOf("/a/b.txt")).toBe("text");
    expect(kindOf("/a/b.rpgle")).toBe("text");
    expect(kindOf("/a/b.bin")).toBe("binary");
    expect(kindOf("/a/noext")).toBe("binary");
  });

  /** 表示できない種別は読みに行かない（100KB/s のホストから無駄に転送しない） */
  it("プレビューできない種別では要求を出さない", async () => {
    const spy = vi.fn();
    globalThis.fetch = spy as unknown as typeof fetch;
    const { api } = harness();
    await api.show("/a/b.bin", 123);
    expect(spy).not.toHaveBeenCalled();
    expect(api.state.value?.kind).toBe("binary");
    expect(api.state.value?.bytes).toBe(123);
  });
});

describe("テキスト", () => {
  it("中身を持つ", async () => {
    mockJson({ content: "hello", bytes: 5, encoding: "utf8" });
    const { api } = harness();
    await api.show("/a/b.txt");
    expect(api.state.value?.text).toBe("hello");
    expect(api.state.value?.undecodable).toBe(false);
  });

  /**
   * サーバーは復号できないとき **200 で `content: null`** を返す。
   * これをエラー扱いにすると、UI は「失敗した」画面を出してしまう。
   * 実際に出したいのは「文字コードを選ぶ / ダウンロードする」という続きの操作。
   */
  it("復号できない場合もエラーにしない", async () => {
    mockJson({ content: null, bytes: 3, encoding: null, code: "UNSUPPORTED_ENCODING" });
    const { api } = harness();
    await api.show("/a/b.txt");
    expect(api.error.value).toBe("");
    expect(api.state.value?.undecodable).toBe(true);
    expect(api.state.value?.bytes).toBe(3);
  });

  it("本当の失敗はエラーにする", async () => {
    mockJson({ error: "File not found (rc=2)", code: "NOT_FOUND" }, 404);
    const { api } = harness();
    await api.show("/a/b.txt");
    // code が付いていれば日本語化される
    expect(api.error.value).not.toContain("rc=");
    expect(api.error.value).toContain("見つかりません");
    expect(api.state.value).toBeUndefined();
  });
});

describe("blob URL の寿命", () => {
  it("表示中は解放しない", async () => {
    const urls = trackUrls();
    mockBlob();
    const { api } = harness();
    await api.show("/a/b.pdf");
    expect(api.state.value?.url).toBe(urls.created[0]);
    // まだ表示中。解放されていないこと
    expect(urls.revoked).toEqual([]);
  });

  /** 次を表示する直前に前のものを解放する（溜め込まない） */
  it("次を表示する直前に前のものを解放する", async () => {
    const urls = trackUrls();
    mockBlob();
    const { api } = harness();
    await api.show("/a/b.pdf");
    await api.show("/a/c.png");
    expect(urls.revoked).toEqual([urls.created[0]]);
    expect(api.state.value?.url).toBe(urls.created[1]);
  });

  /** ペインを閉じたら解放する（タブを消すたびに漏れないように） */
  it("破棄時に解放する", async () => {
    const urls = trackUrls();
    mockBlob();
    const { wrapper, api } = harness();
    await api.show("/a/b.pdf");
    wrapper.unmount();
    expect(urls.revoked).toEqual([urls.created[0]]);
  });

  it("clear でも解放する", async () => {
    const urls = trackUrls();
    mockBlob();
    const { api } = harness();
    await api.show("/a/b.pdf");
    api.clear();
    expect(urls.revoked).toEqual([urls.created[0]]);
    expect(api.state.value).toBeUndefined();
  });
});
