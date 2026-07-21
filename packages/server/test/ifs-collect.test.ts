import { describe, it, expect } from "vitest";
import type { IfsEntry, IfsListResult } from "@as400web/core";
import { collectFiles, readCollected, type IfsReader } from "../src/ifs-collect.js";

/**
 * 偽の口で再帰収集と上限判定を確かめる。
 *
 * ここで守りたいのは **core の decisions D1・D2・D6 の罠**——
 * `entries` が空でも続きがあること、`canContinue` を見ないと無限ループすること。
 * どちらも実機で踏んだもので、型を見ただけでは避けられない。
 */

function entry(name: string, opts: Partial<IfsEntry> = {}): IfsEntry {
  return {
    name,
    isDirectory: false,
    isSymlink: false,
    size: 10,
    modifiedAt: 1_700_000_000_000,
    restartId: 1,
    ...opts
  };
}

/** パス → エントリ列 の辞書から作る、素直な口 */
function reader(tree: Record<string, IfsEntry[]>, data: Record<string, string> = {}): IfsReader {
  return {
    async listFiles(path): Promise<IfsListResult> {
      return { entries: tree[path] ?? [], hasMore: false, canContinue: false };
    },
    async readFile(path): Promise<Uint8Array> {
      return new TextEncoder().encode(data[path] ?? "");
    }
  };
}

const LIMITS = { maxBytes: 1_000_000, maxFiles: 100 };

describe("再帰収集", () => {
  it("サブフォルダを辿って集める", async () => {
    const r = reader({
      "/d": [entry("a.txt"), entry("sub", { isDirectory: true })],
      "/d/sub": [entry("b.txt"), entry("deep", { isDirectory: true })],
      "/d/sub/deep": [entry("c.txt")]
    });
    const result = await collectFiles(r, "/d", LIMITS);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.files.map((f) => f.path).sort()).toEqual(["a.txt", "sub/b.txt", "sub/deep/c.txt"]);
  });

  it("zip の中のパスは対象フォルダからの相対にする", async () => {
    const r = reader({
      "/home/USER/x": [entry("sub", { isDirectory: true })],
      "/home/USER/x/sub": [entry("f.txt")]
    });
    const result = await collectFiles(r, "/home/USER/x", LIMITS);
    expect(result.ok && result.files[0]?.path).toBe("sub/f.txt");
  });

  it("末尾のスラッシュがあっても同じ結果になる", async () => {
    const r = reader({ "/d": [entry("f.txt")] });
    const result = await collectFiles(r, "/d/", LIMITS);
    expect(result.ok && result.files[0]?.path).toBe("f.txt");
  });

  /** リンクは循環しうるし、辿ると対象フォルダの外に出る */
  it("シンボリックリンクは辿らないし、入れもしない", async () => {
    const r = reader({
      "/d": [entry("real.txt"), entry("link", { isSymlink: true }), entry("dlink", { isDirectory: true, isSymlink: true })]
    });
    const result = await collectFiles(r, "/d", LIMITS);
    expect(result.ok && result.files.map((f) => f.path)).toEqual(["real.txt"]);
  });

  it("空のフォルダは空の結果になる", async () => {
    const result = await collectFiles(reader({ "/d": [] }), "/d", LIMITS);
    expect(result.ok && result.files).toEqual([]);
  });
});

/**
 * パスの正規化。**特別扱いを 2 箇所に分けた版では `"//"` で先頭 1 文字が消えた**
 * （review RM2。しかも失敗せず黙って壊れた名前を返す）。
 * 入口で 1 回正規化する規則に直したので、その全ケースを固定する。
 */
describe("パスの正規化", () => {
  const cases: [string, string[], string[]][] = [
    ["/", ["/"], ["a.txt"]],
    ["//", ["/"], ["a.txt"]],
    ["/d", ["/d"], ["a.txt"]],
    ["/d/", ["/d"], ["a.txt"]],
    ["/d//", ["/d"], ["a.txt"]]
  ];
  for (const [root, asked, rel] of cases) {
    it(`${JSON.stringify(root)} → 一覧 ${JSON.stringify(asked)} / 相対 ${JSON.stringify(rel)}`, async () => {
      const seen: string[] = [];
      const r: IfsReader = {
        async listFiles(path): Promise<IfsListResult> {
          seen.push(path);
          return { entries: [entry("a.txt")], hasMore: false, canContinue: false };
        },
        async readFile(): Promise<Uint8Array> {
          return new Uint8Array(0);
        }
      };
      const result = await collectFiles(r, root, LIMITS);
      expect(seen).toEqual(asked);
      expect(result.ok && result.files.map((f) => f.path)).toEqual(rel);
    });
  }

  it("読み取り先のフルパスも正しく組み立てる", async () => {
    const read: string[] = [];
    const r: IfsReader = {
      async listFiles(): Promise<IfsListResult> {
        return { entries: [], hasMore: false, canContinue: false };
      },
      async readFile(path): Promise<Uint8Array> {
        read.push(path);
        return new Uint8Array(0);
      }
    };
    await readCollected(r, "/", [{ path: "a.txt", size: 1, modifiedAt: 0 }]);
    await readCollected(r, "//", [{ path: "a.txt", size: 1, modifiedAt: 0 }]);
    await readCollected(r, "/d/", [{ path: "sub/b.txt", size: 1, modifiedAt: 0 }]);

    expect(read).toEqual(["/a.txt", "/a.txt", "/d/sub/b.txt"]);
  });
});

describe("上限の判定（中身を読む前に効く）", () => {
  it("合計バイトが上限を超えたら拒否する", async () => {
    const r = reader({ "/d": [entry("a", { size: 600 }), entry("b", { size: 600 })] });
    const result = await collectFiles(r, "/d", { maxBytes: 1000, maxFiles: 100 });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("too-large");
    expect(result.bytes).toBeGreaterThan(1000);
  });

  it("件数が上限を超えたら拒否する", async () => {
    const r = reader({ "/d": Array.from({ length: 5 }, (_, i) => entry(`f${i}`)) });
    const result = await collectFiles(r, "/d", { maxBytes: 1_000_000, maxFiles: 3 });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.files).toBe(4);
  });

  /**
   * **上限判定は列挙の段階で効く**。ここで中身を読んでいたら、
   * 100KB/s のホストから全部読み終えてから断ることになる。
   */
  it("拒否するとき、中身を 1 バイトも読んでいない", async () => {
    let reads = 0;
    const r: IfsReader = {
      async listFiles(): Promise<IfsListResult> {
        return {
          entries: [entry("big", { size: 999_999 })],
          hasMore: false,
          canContinue: false
        };
      },
      async readFile(): Promise<Uint8Array> {
        reads++;
        return new Uint8Array(0);
      }
    };
    const result = await collectFiles(r, "/d", { maxBytes: 1000, maxFiles: 10 });
    expect(result.ok).toBe(false);
    expect(reads).toBe(0);
  });

  /**
   * ファイル数とバイト数だけでは、**0 ファイル・大量ディレクトリ**のツリーを止められない。
   * 100KB/s のホストで何時間も往復し続けることになる（review S3）。
   */
  it("ディレクトリが多すぎるときも打ち切る", async () => {
    let calls = 0;
    const r: IfsReader = {
      async listFiles(path): Promise<IfsListResult> {
        // ガードが無いと止まらない。ヒープを食い潰す前に明確に失敗させる（D5 の規約）
        calls++;
        if (calls > 20) throw new Error("ディレクトリを辿り続けている（上限が効いていない）");
        // どこまで潜っても子ディレクトリが 1 つある（ファイルは 0）
        return {
          entries: [entry(`d${path.length}`, { isDirectory: true })],
          hasMore: false,
          canContinue: false
        };
      },
      async readFile(): Promise<Uint8Array> {
        return new Uint8Array(0);
      }
    };
    const result = await collectFiles(r, "/d", {
      maxBytes: 1_000_000,
      maxFiles: 100,
      maxDirectories: 5
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("too-many-directories");
  });

  it("上限ちょうどは通す", async () => {
    const r = reader({ "/d": [entry("a", { size: 500 }), entry("b", { size: 500 })] });
    const result = await collectFiles(r, "/d", { maxBytes: 1000, maxFiles: 2 });
    expect(result.ok).toBe(true);
  });
});

describe("ページングの罠（core の D1・D2・D6）", () => {
  /**
   * `.` と `..` がサーバーの件数上限を消費するため、実データが 0 件でも続きがある。
   * 「空 = 終わり」と解釈すると、中身のあるディレクトリが空に見える。
   */
  it("entries が空でも hasMore が true なら続きを取る", async () => {
    let call = 0;
    const r: IfsReader = {
      async listFiles(): Promise<IfsListResult> {
        call++;
        if (call === 1) {
          // `.` と `..` だけで枠を使い切ったページ
          return { entries: [], hasMore: true, canContinue: true, nextRestartId: 2 };
        }
        return { entries: [entry("found.txt")], hasMore: false, canContinue: false };
      },
      async readFile(): Promise<Uint8Array> {
        return new Uint8Array(0);
      }
    };
    const result = await collectFiles(r, "/d", LIMITS);
    expect(result.ok && result.files.map((f) => f.path)).toEqual(["found.txt"]);
  });

  /**
   * `/QSYS.LIB` は全エントリの Restart ID が 0 で返る。
   * `canContinue` を見ずに回すと、同じページを永久に取り続ける（実機で踏んだ）。
   *
   * **`nextRestartId` を敢えて添えている。** core は `canContinue` が false のとき
   * `nextRestartId` を返さないので、この組み合わせは本来起きない。
   * だが「`nextRestartId` があるかどうか」だけで回す実装は、その契約に寄りかかっている。
   * ここでは契約が破れた場合でも止まることを確かめる——**添えないと `canContinue` の
   * 判定を消しても素通りしてしまい、ガードを検証したことにならない**（実際そうなっていた）。
   */
  it("canContinue が false なら、続きの起点があっても打ち切る（無限ループしない）", async () => {
    let calls = 0;
    const r: IfsReader = {
      async listFiles(): Promise<IfsListResult> {
        calls++;
        // ガードが無いと止まらない。ヒープを食い潰す前に、明確に失敗させる
        if (calls > 10) throw new Error("同じページを取り続けている（無限ループ）");
        // 「まだある」「起点もある」「だが辿れない」
        return {
          entries: [entry(`f${calls}`)],
          hasMore: true,
          canContinue: false,
          nextRestartId: 0
        };
      },
      async readFile(): Promise<Uint8Array> {
        return new Uint8Array(0);
      }
    };
    const result = await collectFiles(r, "/QSYS.LIB", LIMITS);
    // 止まること（無限ループしない）と、黙って成功にしないことの両方
    expect(calls).toBe(1);
    expect(result.ok).toBe(false);
  });

  /**
   * **黙った取りこぼしを起こさない。**
   * 辿れないディレクトリで部分的な結果を `ok: true` で返すと、
   * 呼び出し側は「全部取れた」と思い込み、欠けた zip を利用者に渡してしまう。
   * 欠けに気づけないアーカイブは、失敗するより悪い。
   */
  it("一覧を最後まで辿れないなら、部分的な結果を成功として返さない", async () => {
    const r: IfsReader = {
      async listFiles(): Promise<IfsListResult> {
        // まだあるのに辿れない（`/QSYS.LIB` と同じ形）
        return { entries: [entry("a.txt")], hasMore: true, canContinue: false };
      },
      async readFile(): Promise<Uint8Array> {
        return new Uint8Array(0);
      }
    };
    const result = await collectFiles(r, "/QSYS.LIB", LIMITS);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("incomplete");
    // どこで辿れなくなったかを伝える
    expect(result).toMatchObject({ path: "/QSYS.LIB" });
  });

  /** 深い場所で辿れなくなった場合も、そのパスを伝える */
  it("サブフォルダで辿れなくなったら、そのパスを伝える", async () => {
    const r: IfsReader = {
      async listFiles(path): Promise<IfsListResult> {
        if (path === "/d") {
          return { entries: [entry("sub", { isDirectory: true })], hasMore: false, canContinue: false };
        }
        return { entries: [entry("x.txt")], hasMore: true, canContinue: false };
      },
      async readFile(): Promise<Uint8Array> {
        return new Uint8Array(0);
      }
    };
    const result = await collectFiles(r, "/d", LIMITS);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result).toMatchObject({ reason: "incomplete", path: "/d/sub" });
  });

  it("複数ページにまたがっても全件集まる", async () => {
    let call = 0;
    const r: IfsReader = {
      async listFiles(_p, opts): Promise<IfsListResult> {
        call++;
        if (call === 1) {
          expect(opts?.restartId).toBeUndefined();
          return { entries: [entry("a")], hasMore: true, canContinue: true, nextRestartId: 5 };
        }
        expect(opts?.restartId).toBe(5);
        return { entries: [entry("b")], hasMore: false, canContinue: false };
      },
      async readFile(): Promise<Uint8Array> {
        return new Uint8Array(0);
      }
    };
    const result = await collectFiles(r, "/d", LIMITS);
    expect(result.ok && result.files.map((f) => f.path)).toEqual(["a", "b"]);
  });
});

describe("中身の読み取り", () => {
  /** 列挙時のサイズと実際が食い違ったら、例外ではなく結果で返す（ルートが 413 に写せるように） */
  it("読み取り中に上限を超えたら ok:false で返す", async () => {
    const r: IfsReader = {
      async listFiles(): Promise<IfsListResult> {
        return { entries: [], hasMore: false, canContinue: false };
      },
      async readFile(): Promise<Uint8Array> {
        return new Uint8Array(500);
      }
    };
    const got = await readCollected(r, "/d", [{ path: "a", size: 1, modifiedAt: 0 }], 100);
    expect(got.ok).toBe(false);
    if (got.ok) return;
    expect(got.bytes).toBe(500);
  });

  it("列挙した順に読み、フルパスを組み立てる", async () => {
    const r = reader(
      {},
      { "/d/sub/f.txt": "hello", "/d/g.txt": "world" }
    );
    const got = await readCollected(r, "/d", [
      { path: "sub/f.txt", size: 5, modifiedAt: 0 },
      { path: "g.txt", size: 5, modifiedAt: 0 }
    ]);
    expect(got.ok && got.files.map((x) => new TextDecoder().decode(x.data))).toEqual([
      "hello",
      "world"
    ]);
  });
});
