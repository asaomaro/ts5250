import { describe, it, expect } from "vitest";
import { planDelete, type IfsDeleteReader } from "../src/ifs-delete.js";
import type { IfsEntry, IfsListResult } from "@as400web/core";

/**
 * 削除対象の列挙。**順序が仕様**（深い順・親は最後）——逆に並べると、
 * 中身の残ったディレクトリに rmdir を投げて rc=9 で止まる。
 *
 * 上限・辿れないディレクトリでは **1 件も消させない**（部分削除を作らない）ことも、ここで固定する。
 */
const entry = (name: string, over: Partial<IfsEntry> = {}): IfsEntry => ({
  name,
  isDirectory: false,
  isSymlink: false,
  size: 1,
  modifiedAt: 0,
  restartId: 1,
  ...over
});

/** パス → 中身。ページングは 1 ページで返す */
function reader(tree: Record<string, IfsEntry[]>): IfsDeleteReader {
  return {
    async listFiles(path: string): Promise<IfsListResult> {
      return {
        entries: tree[path] ?? [],
        hasMore: false,
        canContinue: false
      };
    }
  };
}

const limits = { maxEntries: 100, maxDirectories: 50 };

describe("planDelete", () => {
  it("深い順に並べ、親は最後に置く", async () => {
    const r = reader({
      "/d": [entry("a.txt"), entry("sub", { isDirectory: true })],
      "/d/sub": [entry("inner.txt")]
    });
    const plan = await planDelete(r, "/d", limits);
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.targets.map((t) => `${t.kind}:${t.path}`)).toEqual([
      "file:/d/a.txt",
      "file:/d/sub/inner.txt",
      "directory:/d/sub",
      "directory:/d"
    ]);
    expect(plan).toMatchObject({ files: 2, directories: 2 });
  });

  it("空のフォルダは自分だけを返す", async () => {
    const plan = await planDelete(reader({ "/d": [] }), "/d", limits);
    expect(plan).toMatchObject({ ok: true, files: 0, directories: 1 });
  });

  /** リンクを残すと親が空にならず rmdir が rc=9 で止まる。辿らずに対象へ入れる */
  it("シンボリックリンクは辿らないが、削除対象には含める", async () => {
    const r = reader({
      "/d": [entry("link", { isSymlink: true }), entry("dirlink", { isDirectory: true, isSymlink: true })],
      // 辿ってしまうと、この中身まで消してしまう
      "/d/dirlink": [entry("victim.txt")]
    });
    const plan = await planDelete(r, "/d", limits);
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.targets.map((t) => t.path)).toEqual(["/d/link", "/d/dirlink", "/d"]);
    expect(plan.targets.map((t) => t.path)).not.toContain("/d/dirlink/victim.txt");
  });

  it("ルート直下でもパスが二重スラッシュにならない", async () => {
    const plan = await planDelete(reader({ "/": [entry("a.txt")] }), "/", limits);
    expect(plan.ok && plan.targets.map((t) => t.path)).toEqual(["/a.txt", "/"]);
  });

  it("末尾のスラッシュは何本でも正規化する", async () => {
    const plan = await planDelete(reader({ "/d": [entry("a.txt")] }), "/d//", limits);
    expect(plan.ok && plan.targets.map((t) => t.path)).toEqual(["/d/a.txt", "/d"]);
  });

  it("件数の上限を超えたら、対象を返さず断る", async () => {
    const many = Array.from({ length: 10 }, (_, i) => entry(`f${i}.txt`));
    const plan = await planDelete(reader({ "/d": many }), "/d", { ...limits, maxEntries: 5 });
    expect(plan).toMatchObject({ ok: false, reason: "too-many" });
  });

  /** ファイルが 0 件でも件数上限に掛かること（ディレクトリだけの木ですり抜けない。review nit） */
  it("空フォルダばかりでも件数の上限に掛かる", async () => {
    const r = reader({
      "/d": [entry("a", { isDirectory: true }), entry("b", { isDirectory: true })],
      "/d/a": [],
      "/d/b": []
    });
    const plan = await planDelete(r, "/d", { maxEntries: 2, maxDirectories: 50 });
    expect(plan).toMatchObject({ ok: false, reason: "too-many" });
  });

  it("ディレクトリ数の上限を超えたら断る", async () => {
    // 3 段の入れ子
    const r = reader({
      "/d": [entry("a", { isDirectory: true })],
      "/d/a": [entry("b", { isDirectory: true })],
      "/d/a/b": []
    });
    const plan = await planDelete(r, "/d", { ...limits, maxDirectories: 2 });
    expect(plan).toMatchObject({ ok: false, reason: "too-many-directories" });
  });

  /** `/QSYS.LIB` のように続きを辿れない場所。**部分削除は作らない** */
  it("一覧を辿り切れないディレクトリがあれば、そのパスを添えて断る", async () => {
    const r: IfsDeleteReader = {
      async listFiles(path: string): Promise<IfsListResult> {
        if (path === "/d/huge") {
          // 続きはあるが Restart ID が進まない
          return { entries: [entry("x.txt")], hasMore: true, canContinue: false };
        }
        return {
          entries: path === "/d" ? [entry("huge", { isDirectory: true })] : [],
          hasMore: false,
          canContinue: false
        };
      }
    };
    expect(await planDelete(r, "/d", limits)).toEqual({
      ok: false,
      reason: "incomplete",
      path: "/d/huge"
    });
  });

  it("ページングの続きを最後まで辿る（entries が空でも続きがある）", async () => {
    let page = 0;
    const r: IfsDeleteReader = {
      async listFiles(path: string): Promise<IfsListResult> {
        if (path !== "/d") return { entries: [], hasMore: false, canContinue: false };
        page++;
        // 1 ページ目は `.`/`..` だけが上限を消費して空、2 ページ目に本体が来る
        if (page === 1) {
          return { entries: [], hasMore: true, canContinue: true, nextRestartId: 2 };
        }
        return { entries: [entry("a.txt")], hasMore: false, canContinue: false };
      }
    };
    const plan = await planDelete(r, "/d", limits);
    expect(plan.ok && plan.targets.map((t) => t.path)).toEqual(["/d/a.txt", "/d"]);
  });
});
