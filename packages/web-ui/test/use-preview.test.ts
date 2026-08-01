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
function harness(limits?: () => { readMaxBytes: number } | undefined) {
  let api: ReturnType<typeof usePreview> | undefined;
  const wrapper = mount(
    defineComponent({
      setup() {
        api = usePreview(() => ({ system: "srv:s" }), limits);
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

  /**
   * **IBM i の資産はテキストとして開けること。**
   * ソースや DDS をバイナリ扱いにすると「ダウンロードしてください」に落ち、画面で確認できない。
   */
  it("IBM i のソース・DDS をテキストとして扱う", () => {
    for (const ext of [
      "rpg", "rpgle", "sqlrpg", "sqlrpgle", "clp", "clle", "cl", "cmd", "cbl",
      "dspf", "prtf", "pf", "lf", "mbr", "dds"
    ]) {
      expect(kindOf(`/a/SRC.${ext}`)).toBe("text");
      // 大文字（IBM i のメンバー名は大文字が普通）
      expect(kindOf(`/a/SRC.${ext.toUpperCase()}`)).toBe("text");
    }
  });

  it("一般的なテキスト・設定・スクリプトをテキストとして扱う", () => {
    for (const ext of [
      "txt", "log", "ini", "properties", "json", "jsonl", "xml", "yml", "toml",
      "csv", "tsv", "sql", "html", "js", "ts", "java", "py", "sh", "bat", "ps1"
    ]) {
      expect(kindOf(`/a/f.${ext}`)).toBe("text");
    }
  });

  /** `.bashrc` `.gitignore` の類。設定ファイルなのでテキストで開く */
  it("ドットで始まる拡張子なしのファイルはテキスト", () => {
    expect(kindOf("/home/USER/.bashrc")).toBe("text");
    expect(kindOf("/home/USER/.gitignore")).toBe("text");
    expect(kindOf("/.profile")).toBe("text");
    // ドットで始まっても拡張子があれば、その拡張子で判定する
    expect(kindOf("/home/USER/.config.json")).toBe("text");
    expect(kindOf("/home/USER/.cache.bin")).toBe("binary");
  });

  it("拡張子の判定はファイル名だけを見る（フォルダ名のドットに引きずられない）", () => {
    expect(kindOf("/a.txt/noext")).toBe("binary");
    expect(kindOf("/v1.2/readme.md")).toBe("text");
  });

  /** svg はテキストでもあるが、画像として描ける方を採る */
  it("svg は画像として扱う", () => {
    expect(kindOf("/a/logo.svg")).toBe("image");
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

/**
 * 応答の解決タイミングを外から決められる fetch モック。
 *
 * 既存の `mockJson` は即時解決なので**順序を作れない**。競合の検証には
 * 「A を先に発行し、B を後に発行し、B を先に解決する」形が要る。
 */
function deferredFetch() {
  const pending: { path: string; body: unknown; status: number; send: () => void }[] = [];
  globalThis.fetch = vi.fn(
    (_input: unknown, init?: RequestInit) =>
      new Promise<Response>((res) => {
        const parsed = JSON.parse(String(init?.body ?? "{}")) as { path?: string };
        const entry = {
          path: parsed.path ?? "",
          body: undefined as unknown,
          status: 200,
          send: (): void => {}
        };
        entry.send = () =>
          res(
            new Response(JSON.stringify(entry.body), {
              status: entry.status,
              headers: { "content-type": "application/json" }
            })
          );
        pending.push(entry);
      })
  ) as unknown as typeof fetch;
  return {
    /** path で発行済みの要求を探し、指定の本文で解決する */
    async settle(path: string, body: unknown, status = 200): Promise<void> {
      const e = pending.find((p) => p.path === path);
      if (!e) {
        throw new Error(`要求が見つからない: ${path}（発行済み: ${pending.map((p) => p.path).join(",")}）`);
      }
      e.body = body;
      e.status = status;
      e.send();
      await Promise.resolve();
      await Promise.resolve();
    }
  };
}

/**
 * プレビューの競合（03 review S3）。
 *
 * IFS は実効 100KB/s なので、大きい A の直後に小さい B を選ぶと **B が先に返る**。
 * 門番が無いと後から届いた A が B を上書きし、選んでいないファイルが表示される。
 * 守るべき代入は 4 か所あり（state×2 / error / loading）、1 つでも漏れると症状が残る。
 */
describe("競合（遅い応答が後から勝たない）", () => {
  it("後から選んだ方が表示される（テキストの state）", async () => {
    const f = deferredFetch();
    const { api } = harness();
    const a = api.show("/a/slow.txt");
    const b = api.show("/a/fast.txt");
    await f.settle("/a/fast.txt", { content: "B", bytes: 1, encoding: "utf8" });
    await f.settle("/a/slow.txt", { content: "A", bytes: 1, encoding: "utf8" });
    await Promise.all([a, b]);
    expect(api.state.value?.path).toBe("/a/fast.txt");
    expect(api.state.value?.text).toBe("B");
  });

  it("古い要求の失敗が新しい表示を消さない（error）", async () => {
    const f = deferredFetch();
    const { api } = harness();
    const a = api.show("/a/slow.txt");
    const b = api.show("/a/fast.txt");
    await f.settle("/a/fast.txt", { content: "B", bytes: 1, encoding: "utf8" });
    await f.settle("/a/slow.txt", { error: "boom", code: "NOT_FOUND" }, 404);
    await Promise.all([a, b]);
    expect(api.error.value).toBe("");
    expect(api.state.value?.text).toBe("B");
  });

  /** 守らないと「読み込み中なのに何も起きていないように見える」 */
  it("古い応答がローディングを消さない（finally）", async () => {
    const f = deferredFetch();
    const { api } = harness();
    const a = api.show("/a/slow.txt");
    const b = api.show("/a/fast.txt");
    await f.settle("/a/slow.txt", { content: "A", bytes: 1, encoding: "utf8" });
    expect(api.loading.value).toBe(true);
    await f.settle("/a/fast.txt", { content: "B", bytes: 1, encoding: "utf8" });
    await Promise.all([a, b]);
    expect(api.loading.value).toBe(false);
  });

  /**
   * blob は **URL を作る前に捨てる**。作ってから捨てると `revoke()` は
   * `state.value?.url` しか見ないので解放する当てが無くなる（作らなければ漏れない）。
   */
  it("捨てる応答では blob URL を作らない", async () => {
    const urls = trackUrls();
    const f = deferredFetch();
    const { api } = harness();
    const a = api.show("/a/slow.pdf");
    const b = api.show("/a/fast.pdf");
    await f.settle("/a/fast.pdf", {});
    await f.settle("/a/slow.pdf", {});
    await Promise.all([a, b]);
    // 表示されている 1 本だけ。捨てた方は作られていない＝漏れようがない
    expect(urls.created).toHaveLength(1);
    expect(api.state.value?.url).toBe(urls.created[0]);
    expect(urls.revoked).toEqual([]);
  });

  /** reload の巻き戻し（失敗時に直前の表示へ戻す）が、新しい表示を潰さない */
  it("reload の巻き戻しが新しい表示を上書きしない", async () => {
    mockJson({ content: "first", bytes: 5, encoding: "utf8", ccsid: 1399 });
    const { api } = harness();
    await api.show("/a/b.txt");

    const f = deferredFetch();
    const r = api.reload(37);
    const s = api.show("/a/other.txt");
    await f.settle("/a/other.txt", { content: "NEW", bytes: 3, encoding: "utf8" });
    await f.settle("/a/b.txt", { error: "boom", code: "NOT_FOUND" }, 404);
    await Promise.all([r, s]);
    expect(api.state.value?.path).toBe("/a/other.txt");
    expect(api.state.value?.text).toBe("NEW");
  });
});

/**
 * 先回り（03 D11 / backlog hostserver.md:202）。
 *
 * 一覧が持っているサイズで上限超過と分かるなら、サーバーが 413 を返すまで待たせる理由が無い。
 * ただし**断るのは「サイズが分かっていて、上限も分かっていて、超えている」ときだけ**——
 * どちらかが不明なまま断ると、読めるファイルを見せられなくなり従来より劣化する。
 */
describe("サイズの先回り判定", () => {
  const max = () => ({ readMaxBytes: 1000 });

  it("上限超過なら要求を出さずに断る", async () => {
    const spy = vi.fn();
    globalThis.fetch = spy as unknown as typeof fetch;
    const { api } = harness(max);
    await api.show("/a/big.txt", 2000);
    expect(spy).not.toHaveBeenCalled();
    expect(api.state.value?.tooLarge).toBe(true);
    expect(api.state.value?.maxBytes).toBe(1000);
    // **kind は保つ**——「バイナリで見せられない」と「大きすぎる」は別の理由
    expect(api.state.value?.kind).toBe("text");
    expect(api.error.value).toBe("");
  });

  /** サーバーも `>` で判定するので、同値は通す（境界の食い違いを作らない） */
  it("上限と同値なら読みに行く", async () => {
    mockJson({ content: "ok", bytes: 1000, encoding: "utf8" });
    const { api } = harness(max);
    await api.show("/a/edge.txt", 1000);
    expect(api.state.value?.tooLarge).toBeUndefined();
    expect(api.state.value?.text).toBe("ok");
  });

  it("サイズが分からなければ断らない", async () => {
    mockJson({ content: "ok", bytes: 9999, encoding: "utf8" });
    const { api } = harness(max);
    await api.show("/a/unknown.txt");
    expect(api.state.value?.tooLarge).toBeUndefined();
  });

  /** /limits がまだ返っていない間は従来動作（劣化させない） */
  it("上限が分からなければ断らない", async () => {
    mockJson({ content: "ok", bytes: 9999, encoding: "utf8" });
    const { api } = harness(() => undefined);
    await api.show("/a/big.txt", 999999);
    expect(api.state.value?.tooLarge).toBeUndefined();
  });
});

/**
 * ヌルバイト判定。**文字コードの問題と混同させない**——
 * `undecodable` の案内を出すと、利用者は当たらない文字コードを選び直し続けることになる。
 */
describe("中身のバイナリ判定", () => {
  /** リテラルで書くとソースに生の制御文字が入るので、コードから作る */
  const NUL = String.fromCharCode(0);

  it("復号できた中身にヌルバイトがあればバイナリ扱い", async () => {
    mockJson({ content: `ab${NUL}cd`, bytes: 5, encoding: "utf8" });
    const { api } = harness();
    await api.show("/a/b.log");
    expect(api.state.value?.binaryContent).toBe(true);
    // 読み取り自体は成功しているのでエラーではない
    expect(api.error.value).toBe("");
    expect(api.state.value?.undecodable).toBe(false);
  });

  it("普通のテキストでは立たない", async () => {
    mockJson({ content: "hello", bytes: 5, encoding: "utf8" });
    const { api } = harness();
    await api.show("/a/b.log");
    expect(api.state.value?.binaryContent).toBeUndefined();
  });

  /** 復号できなければ中身を見る手段が無い。`undecodable` の案内のまま */
  it("復号できなかった場合は判定しない", async () => {
    mockJson({ content: null, bytes: 5, encoding: null });
    const { api } = harness();
    await api.show("/a/b.log");
    expect(api.state.value?.binaryContent).toBeUndefined();
    expect(api.state.value?.undecodable).toBe(true);
  });
});

/**
 * 読まずに終わる分岐（`binary` / `tooLarge`）でもローディングを落とす。
 *
 * **門番を入れたことで生まれた退行**（review ラウンド 1 の must）。
 * 先行する遅い要求が居ると、その `finally` は `isStale()` で握られる＝
 * 誰も `loading` を落とさなくなり、`true` に張り付く。
 */
describe("読まずに終わる分岐のローディング", () => {
  it("binary を選んでもローディングが残らない", async () => {
    const f = deferredFetch();
    const { api } = harness();
    const slow = api.show("/a/slow.txt");
    expect(api.loading.value).toBe(true);
    // 応答を待たずに、読みに行かない種別へ切り替える
    await api.show("/a/x.bin", 10);
    expect(api.loading.value).toBe(false);
    // 先行要求が後から返っても、握られるだけで状態は動かない
    await f.settle("/a/slow.txt", { content: "A", bytes: 1, encoding: "utf8" });
    await slow;
    expect(api.loading.value).toBe(false);
    expect(api.state.value?.kind).toBe("binary");
  });

  it("上限超過で断ったときもローディングが残らない", async () => {
    const f = deferredFetch();
    const { api } = harness(() => ({ readMaxBytes: 1000 }));
    const slow = api.show("/a/slow.txt");
    expect(api.loading.value).toBe(true);
    await api.show("/a/big.txt", 5000);
    expect(api.loading.value).toBe(false);
    await f.settle("/a/slow.txt", { content: "A", bytes: 1, encoding: "utf8" });
    await slow;
    expect(api.loading.value).toBe(false);
    expect(api.state.value?.tooLarge).toBe(true);
  });
});
