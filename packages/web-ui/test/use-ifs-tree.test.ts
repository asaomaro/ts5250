import { describe, it, expect, afterEach, vi } from "vitest";
import { useIfsTree } from "../src/composables/useIfsTree.js";
import type { IfsListResult } from "@as400web/core/browser";

/**
 * ツリーの状態。**サーバーの「素直に読むと間違える」形を吸収できているか**を見る。
 *
 * どちらも実機で踏んだもの:
 * - `entries` が空でも `hasMore` が true になりうる（`.` と `..` が件数上限を消費する）
 * - `canContinue` を見ずに続きを取ると `/QSYS.LIB` で無限ループする
 */
const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

const entry = (name: string, over: Record<string, unknown> = {}) => ({
  name,
  isDirectory: false,
  isSymlink: false,
  size: 1,
  modifiedAt: 0,
  restartId: 1,
  ...over
});

/** 呼ばれるたびに次の応答を返す偽 fetch。要求本文も記録する */
function mockList(pages: IfsListResult[]) {
  const bodies: Record<string, unknown>[] = [];
  let at = 0;
  globalThis.fetch = vi.fn(async (_url: unknown, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    const page = pages[Math.min(at++, pages.length - 1)] as IfsListResult;
    return new Response(JSON.stringify(page), {
      status: 200,
      headers: { "content-type": "application/json" }
    });
  }) as unknown as typeof fetch;
  return { bodies, calls: () => at };
}

const source = () => ({ system: "srv:s" });

describe("読み込み", () => {
  it("ディレクトリの中身を取る", async () => {
    mockList([{ entries: [entry("a"), entry("b")], hasMore: false, canContinue: false }]);
    const tree = useIfsTree(source);
    await tree.load("/d");
    const node = tree.nodeAt("/d");
    expect(node.state).toBe("loaded");
    expect(node.entries.map((e) => e.name)).toEqual(["a", "b"]);
  });

  it("件数の上限を要求に載せる（巨大ディレクトリ対策）", async () => {
    const m = mockList([{ entries: [], hasMore: false, canContinue: false }]);
    await useIfsTree(source).load("/d");
    expect(m.bodies[0]).toMatchObject({ path: "/d", maxCount: 1000 });
  });

  it("失敗したら error 状態にして、日本語の文言を残す", async () => {
    // code が付いていれば日本語化される（英語の生文言を画面に出さない）
    globalThis.fetch = vi.fn(async () =>
      new Response(JSON.stringify({ error: "File not found (rc=2)", code: "NOT_FOUND" }), {
        status: 404,
        headers: { "content-type": "application/json" }
      })
    ) as unknown as typeof fetch;
    const tree = useIfsTree(source);
    await tree.load("/nope");
    expect(tree.nodeAt("/nope").state).toBe("error");
    // 英語の生文言（rc 付き）ではなく日本語
    expect(tree.nodeAt("/nope").error).not.toContain("rc=");
    expect(tree.nodeAt("/nope").error).toContain("見つかりません");
  });
});

describe("ページングの罠", () => {
  /**
   * `.` と `..` が件数上限を消費するため、実データが 0 件でも続きがある。
   * ここで `loaded` にすると、中身のあるフォルダが空に見える。
   */
  it("entries が空でも、続きがあるなら loaded にしない", async () => {
    mockList([{ entries: [], hasMore: true, canContinue: true, nextRestartId: 2 }]);
    const tree = useIfsTree(source);
    await tree.load("/d");
    expect(tree.nodeAt("/d").state).toBe("partial");
    expect(tree.nodeAt("/d").blocked).toBe(false);
  });

  it("続きを取ると積み上がる", async () => {
    const m = mockList([
      { entries: [entry("a")], hasMore: true, canContinue: true, nextRestartId: 5 },
      { entries: [entry("b")], hasMore: false, canContinue: false }
    ]);
    const tree = useIfsTree(source);
    await tree.load("/d");
    await tree.loadMore("/d");
    expect(tree.nodeAt("/d").entries.map((e) => e.name)).toEqual(["a", "b"]);
    expect(tree.nodeAt("/d").state).toBe("loaded");
    // 2 回目の要求に起点が載っている
    expect(m.bodies[1]).toMatchObject({ restartId: 5 });
  });

  /**
   * `/QSYS.LIB` は全エントリの Restart ID が 0 で返る。
   * **ここが緩むと画面が無限に読み続ける。**
   */
  it("辿れない場所では blocked にし、続きを取りに行かない", async () => {
    const m = mockList([{ entries: [entry("a")], hasMore: true, canContinue: false }]);
    const tree = useIfsTree(source);
    await tree.load("/QSYS.LIB");
    expect(tree.nodeAt("/QSYS.LIB").state).toBe("partial");
    expect(tree.nodeAt("/QSYS.LIB").blocked).toBe(true);

    // 続きを頼まれても要求を出さない
    await tree.loadMore("/QSYS.LIB");
    await tree.loadMore("/QSYS.LIB");
    expect(m.calls()).toBe(1);
  });

  /**
   * **`blocked` のガードは、`nextRestartId` が無いことに寄りかかっていない**ことを確かめる。
   *
   * 現状サーバーは `canContinue: false` のとき `nextRestartId` を返さないので、
   * 「起点が無いから止まる」だけでも結果は同じになる。だがその契約が破れたとき、
   * ガードが実際に効いていないと画面が無限に読み続ける。
   * 起こりえない組み合わせを直接組み立てて、ガード自体を通す。
   */
  it("起点があっても blocked なら続きを取らない", async () => {
    const m = mockList([{ entries: [entry("a")], hasMore: true, canContinue: false }]);
    const tree = useIfsTree(source);
    await tree.load("/QSYS.LIB");

    // 契約が破れた状態を作る（blocked なのに起点がある）
    const copy = new Map(tree.nodes.value);
    copy.set("/QSYS.LIB", { ...tree.nodeAt("/QSYS.LIB"), nextRestartId: 0 });
    tree.nodes.value = copy;

    await tree.loadMore("/QSYS.LIB");
    expect(m.calls()).toBe(1);
  });

  /**
   * **`loadPage` 側の `canContinue` 判定を通す。**
   *
   * サーバーは `canContinue: false` のとき `nextRestartId` を返さないので、
   * 素直な応答では後段の `nextRestartId === undefined` で先に止まり、
   * **判定自体が一度も実行されない**（review S1。01-D8 / 02-D5 と同型）。
   * 契約が破れた組み合わせを与えて、判定そのものを効かせる。
   */
  it("起点があっても canContinue が false なら blocked にする", async () => {
    mockList([{ entries: [entry("a")], hasMore: true, canContinue: false, nextRestartId: 5 }]);
    const tree = useIfsTree(source);
    await tree.load("/QSYS.LIB");
    expect(tree.nodeAt("/QSYS.LIB").blocked).toBe(true);
    expect(tree.nodeAt("/QSYS.LIB").nextRestartId).toBeUndefined();
  });

  /** 全件が要る場面（zip の前など）でも、辿れない場所で回り続けない */
  it("loadAll は辿れない場所で止まる", async () => {
    const m = mockList([{ entries: [entry("a")], hasMore: true, canContinue: false }]);
    const tree = useIfsTree(source);
    await tree.loadAll("/QSYS.LIB");
    expect(m.calls()).toBe(1);
  });

  /** サーバーが際限なく「続きがある」と言い続けても止まる */
  it("loadAll には回数の歯止めがある", async () => {
    const m = mockList([
      { entries: [entry("x")], hasMore: true, canContinue: true, nextRestartId: 1 }
    ]);
    const tree = useIfsTree(source);
    await tree.loadAll("/d");
    expect(m.calls()).toBeLessThanOrEqual(21);
    expect(m.calls()).toBeGreaterThan(1);
  });
});

describe("展開と再取得", () => {
  it("展開すると読み込み、畳むと要求しない", async () => {
    const m = mockList([{ entries: [entry("a")], hasMore: false, canContinue: false }]);
    const tree = useIfsTree(source);
    await tree.toggle("/d");
    expect(tree.expanded.value.has("/d")).toBe(true);
    await tree.toggle("/d");
    expect(tree.expanded.value.has("/d")).toBe(false);
    expect(m.calls()).toBe(1);
  });

  it("再取得は取り直す（作成・削除の後に使う）", async () => {
    const m = mockList([
      { entries: [entry("a")], hasMore: false, canContinue: false },
      { entries: [entry("a"), entry("b")], hasMore: false, canContinue: false }
    ]);
    const tree = useIfsTree(source);
    await tree.load("/d");
    await tree.refresh("/d");
    expect(m.calls()).toBe(2);
    expect(tree.nodeAt("/d").entries.map((e) => e.name)).toEqual(["a", "b"]);
  });

  it("読み込み済みなら再要求しない", async () => {
    const m = mockList([{ entries: [entry("a")], hasMore: false, canContinue: false }]);
    const tree = useIfsTree(source);
    await tree.load("/d");
    await tree.load("/d");
    expect(m.calls()).toBe(1);
  });
});
