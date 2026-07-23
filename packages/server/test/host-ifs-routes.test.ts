import { describe, it, expect } from "vitest";
import { Hono } from "hono";
import { As400Error, type IfsConnection, type IfsListResult } from "@as400web/core";
import type { AuthVars } from "../src/auth.js";
import { ConfigResolver } from "../src/config-resolver.js";
import { PersonalConfigStore, ServerConfigStore } from "../src/config-store.js";
import { registerHostIfsRoutes } from "../src/host-ifs.js";

/**
 * **ルートのハンドラ本体を実際に通す。**
 *
 * これが無かったのが review の M4。以前のテストは入力検証（zod）と
 * `statusOf` の直接呼び出ししか通しておらず、**413 を 500 に書き換えても全件緑**だった。
 * 偽の接続を差し込めるようにして、応答の組み立て・分岐・ヘッダを固定する。
 */

interface FakeOpts {
  list?: Record<string, IfsListResult>;
  files?: Record<string, Uint8Array>;
  /** ファイル内容の CCSID タグ（OA2）。`readTextFile` が返す */
  tags?: Record<string, number>;
  fail?: As400Error;
  /** 呼ばれた操作を記録する */
  calls?: string[];
}

function fakeConn(opts: FakeOpts): IfsConnection {
  const conn = {
    async listFiles(path: string): Promise<IfsListResult> {
      opts.calls?.push(`list ${path}`);
      if (opts.fail) throw opts.fail;
      return opts.list?.[path] ?? { entries: [], hasMore: false, canContinue: false };
    },
    async readFile(path: string): Promise<Uint8Array> {
      opts.calls?.push(`read ${path}`);
      if (opts.fail) throw opts.fail;
      return opts.files?.[path] ?? new Uint8Array(0);
    },
    // テキスト読み取りは内容 ＋ CCSID タグ。タグが無いファイルは undefined を返す
    async readTextFile(path: string): Promise<{ data: Uint8Array; ccsid?: number }> {
      opts.calls?.push(`readText ${path}`);
      if (opts.fail) throw opts.fail;
      const data = opts.files?.[path] ?? new Uint8Array(0);
      const ccsid = opts.tags?.[path];
      return ccsid !== undefined ? { data, ccsid } : { data };
    },
    async writeFile(path: string, data: Uint8Array): Promise<void> {
      opts.calls?.push(`write ${path} ${data.length}`);
      if (opts.fail) throw opts.fail;
    },
    async makeDirectory(path: string): Promise<void> {
      opts.calls?.push(`mkdir ${path}`);
      if (opts.fail) throw opts.fail;
    },
    async deleteFile(path: string): Promise<void> {
      opts.calls?.push(`delete ${path}`);
      if (opts.fail) throw opts.fail;
    },
    close(): void {
      opts.calls?.push("close");
    }
  };
  return conn as unknown as IfsConnection;
}

function appWith(
  opts: FakeOpts,
  limits?: Partial<{ zip: number; files: number; read: number; dirs: number }>
) {
  const app = new Hono<{ Variables: AuthVars }>();
  const server = new ServerConfigStore({
    systems: [{ id: "s", name: "s", host: "example.invalid" }],
    sessions: []
  });
  registerHostIfsRoutes(app, {
    resolver: new ConfigResolver(server, new PersonalConfigStore()),
    zipMaxBytes: limits?.zip ?? 1_000_000,
    zipMaxFiles: limits?.files ?? 100,
    readMaxBytes: limits?.read ?? 1_000_000,
    ...(limits?.dirs !== undefined ? { zipMaxDirectories: limits.dirs } : {}),
    connect: async () => fakeConn(opts)
  });
  return app;
}

const SOURCE = { system: "srv:s" };

async function call(app: ReturnType<typeof appWith>, route: string, body: unknown) {
  return app.request(`/api/host/ifs/${route}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ source: SOURCE, ...(body as object) })
  });
}

const entry = (name: string, over: Record<string, unknown> = {}) => ({
  name,
  isDirectory: false,
  isSymlink: false,
  size: 3,
  modifiedAt: 1_700_000_000_000,
  restartId: 1,
  ...over
});

describe("list", () => {
  it("core の結果をそのまま返す（hasMore / canContinue を含む）", async () => {
    const app = appWith({
      list: {
        "/d": { entries: [entry("a")], hasMore: true, canContinue: true, nextRestartId: 7 }
      }
    });
    const res = await call(app, "list", { path: "/d" });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      hasMore: true,
      canContinue: true,
      nextRestartId: 7
    });
  });

  it("接続は必ず閉じる", async () => {
    const calls: string[] = [];
    await call(appWith({ calls }), "list", { path: "/d" });
    expect(calls).toContain("close");
  });

  it("失敗しても接続を閉じる", async () => {
    const calls: string[] = [];
    await call(appWith({ calls, fail: new As400Error("NOT_FOUND", "x") }), "list", { path: "/d" });
    expect(calls).toContain("close");
  });
});

describe("read", () => {
  it("UTF-8 のテキストを返す", async () => {
    const app = appWith({ files: { "/d/f": new TextEncoder().encode("日本語") } });
    expect(await (await call(app, "read", { path: "/d/f" })).json()).toMatchObject({
      content: "日本語",
      bytes: 9
    });
  });

  /**
   * **化けさせない。** IFS のテキストは EBCDIC が普通にあり、
   * 非 fatal な TextDecoder は U+FFFD の羅列を黙って返す。
   * それを編集して書き戻すと元ファイルが壊れる。
   */
  it("UTF-8 として読めないものは content=null で返す（U+FFFD にしない）", async () => {
    // EBCDIC 273 の "ABC" 相当（UTF-8 として不正な並び）
    const ebcdic = new Uint8Array([0xc1, 0xc2, 0xc3]);
    const res = await call(appWith({ files: { "/d/f": ebcdic } }), "read", { path: "/d/f" });
    // 読み取り自体は成功している。足りないのは表示手段なので 4xx にしない
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      content: null,
      encoding: null,
      code: "UNSUPPORTED_ENCODING",
      bytes: 3
    });
  });

  it("タグ（CCSID）に従って EBCDIC を復号し、根拠を添えて返す", async () => {
    // 実機で作った 1399 のファイル（research F5 と同じバイト列）
    const bytes = new Uint8Array([
      0x0e, 0x45, 0x62, 0x45, 0x66, 0x48, 0xe7, 0x43, 0x94, 0x43, 0x8e, 0x43, 0x95, 0x0f, 0x7c,
      0x81, 0x82, 0x83, 0x25
    ]);
    const app = appWith({ files: { "/d/f": bytes }, tags: { "/d/f": 1399 } });
    expect(await (await call(app, "read", { path: "/d/f" })).json()).toMatchObject({
      content: "日本語テスト@abc\n",
      ccsid: 1399,
      detectedBy: "tag",
      tagCcsid: 1399,
      newline: "lf"
    });
  });

  /** 我々が書いたファイルはタグが中身を説明していない（UTF-8 の内容に 850）。research F4 */
  it("タグが違っていても、中身が UTF-8 として読めればそちらを採る", async () => {
    const app = appWith({
      files: { "/d/f": new TextEncoder().encode("日本語") },
      tags: { "/d/f": 850 }
    });
    expect(await (await call(app, "read", { path: "/d/f" })).json()).toMatchObject({
      content: "日本語",
      ccsid: 1208,
      detectedBy: "content",
      tagCcsid: 850
    });
  });

  it("読めなかったときはタグを添えて返す（UI が手掛かりを出せる）", async () => {
    const app = appWith({ files: { "/d/f": new Uint8Array([0xc1, 0xc2]) }, tags: { "/d/f": 850 } });
    expect(await (await call(app, "read", { path: "/d/f" })).json()).toMatchObject({
      content: null,
      code: "UNSUPPORTED_ENCODING",
      tagCcsid: 850
    });
  });

  it("手動指定の文字コードで読み直せる", async () => {
    const app = appWith({ files: { "/d/f": new Uint8Array([0xc1, 0xc2, 0xc3]) } });
    const res = await call(app, "read", { path: "/d/f", ccsid: 273 });
    expect(await res.json()).toMatchObject({ content: "ABC", ccsid: 273, detectedBy: "manual" });
  });

  it("手動指定が未対応・読めないときは 400（利用者の選択の問題なので）", async () => {
    const app = appWith({ files: { "/d/f": new Uint8Array([0xc1]) } });
    const unsupported = await call(app, "read", { path: "/d/f", ccsid: 850 });
    expect(unsupported.status).toBe(400);
    expect(await unsupported.json()).toMatchObject({ code: "UNSUPPORTED_CCSID" });

    const failed = await call(app, "read", { path: "/d/f", ccsid: 1208 });
    expect(failed.status).toBe(400);
    expect(await failed.json()).toMatchObject({ code: "DECODE_FAILED" });
  });

  it("base64 要求では CCSID タグを引かない（往復を増やさない）", async () => {
    const calls: string[] = [];
    await call(appWith({ calls, files: { "/d/f": new Uint8Array([1]) } }), "read", {
      path: "/d/f",
      encoding: "base64"
    });
    expect(calls).toContain("read /d/f");
    expect(calls.some((x) => x.startsWith("readText"))).toBe(false);
  });

  it("base64 ならバイナリでも返せる（encoding も揃える）", async () => {
    const app = appWith({ files: { "/d/f": new Uint8Array([0xc1, 0xc2]) } });
    const res = await call(app, "read", { path: "/d/f", encoding: "base64" });
    expect(await res.json()).toMatchObject({ content: "wcI=", encoding: "base64" });
  });

  /** 100KB/s では 5MB でも約 50 秒。画面に出さずダウンロードへ誘導する */
  it("大きすぎるファイルは 413", async () => {
    const app = appWith({ files: { "/d/big": new Uint8Array(2000) } }, { read: 1000 });
    const res = await call(app, "read", { path: "/d/big" });
    expect(res.status).toBe(413);
    expect(await res.json()).toMatchObject({ code: "TOO_LARGE", bytes: 2000, maxBytes: 1000 });
  });
});

describe("write / mkdir / delete", () => {
  it("utf8 の内容を書く", async () => {
    const calls: string[] = [];
    const res = await call(appWith({ calls }), "write", { path: "/d/f", content: "abc" });
    expect(await res.json()).toMatchObject({ bytes: 3 });
    expect(calls).toContain("write /d/f 3");
  });

  it("指定された文字コードで符号化して書く（行末も戻す）", async () => {
    const calls: string[] = [];
    await call(appWith({ calls }), "write", {
      path: "/d/f",
      content: "a\nb\n",
      ccsid: 37,
      newline: "nel"
    });
    // "a" 0x15 "b" 0x15 の 4 バイト（UTF-8 なら 4 バイトだが中身が違う）
    expect(calls).toContain("write /d/f 4");
  });

  it("マップ不能な文字は SUB に落として件数を返す（保存は止めない）", async () => {
    const res = await call(appWith({}), "write", { path: "/d/f", content: "A日", ccsid: 819 });
    expect(await res.json()).toMatchObject({ bytes: 2, substituted: 1 });
  });

  it("符号化できない文字コードは 400 で断る（化けたまま保存しない）", async () => {
    const calls: string[] = [];
    const res = await call(appWith({ calls }), "write", {
      path: "/d/f",
      content: "あ",
      ccsid: 943
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code: "UNSUPPORTED_CCSID" });
    expect(calls.some((x) => x.startsWith("write"))).toBe(false);
  });

  it("base64 の内容を復号して書く", async () => {
    const calls: string[] = [];
    await call(appWith({ calls }), "write", {
      path: "/d/f",
      content: "wcI=",
      encoding: "base64"
    });
    expect(calls).toContain("write /d/f 2");
  });

  it("mkdir と delete が対象パスに届く", async () => {
    const calls: string[] = [];
    await call(appWith({ calls }), "mkdir", { path: "/d/new" });
    await call(appWith({ calls }), "delete", { path: "/d/old" });
    expect(calls).toContain("mkdir /d/new");
    expect(calls).toContain("delete /d/old");
  });

  it("既存なら 409（core のコードがそのまま写る）", async () => {
    const app = appWith({ fail: new As400Error("ALREADY_EXISTS", "dup") });
    expect((await call(app, "mkdir", { path: "/d/x" })).status).toBe(409);
  });

  it("権限が無ければ 403", async () => {
    const app = appWith({ fail: new As400Error("ACCESS_DENIED", "no") });
    expect((await call(app, "delete", { path: "/d/x" })).status).toBe(403);
  });
});

describe("download", () => {
  it("拡張子から Content-Type を決め、添付として返す", async () => {
    const app = appWith({ files: { "/d/a.pdf": new Uint8Array([1, 2, 3]) } });
    const res = await call(app, "download", { path: "/d/a.pdf" });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/pdf");
    expect(res.headers.get("content-disposition")).toContain("attachment");
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]));
  });

  /** 名前に CR/LF や引用符が入ってもヘッダを壊さない */
  it("非 ASCII や記号を含む名前をエスケープする", async () => {
    const name = '/d/日本語 "x".txt';
    const app = appWith({ files: { [name]: new Uint8Array([1]) } });
    const cd = (await call(app, "download", { path: name })).headers.get("content-disposition");
    expect(cd).toContain("filename*=UTF-8''");
    expect(cd).not.toContain('"x"');
    expect(cd).not.toMatch(/[\r\n]/);
  });

  it("知らない拡張子は汎用のバイナリ", async () => {
    const app = appWith({ files: { "/d/a.xyz": new Uint8Array([1]) } });
    const res = await call(app, "download", { path: "/d/a.xyz" });
    expect(res.headers.get("content-type")).toBe("application/octet-stream");
  });
});

describe("zip", () => {
  it("収集して ZIP を返す", async () => {
    const app = appWith({
      list: {
        "/d": { entries: [entry("a.txt")], hasMore: false, canContinue: false }
      },
      files: { "/d/a.txt": new TextEncoder().encode("abc") }
    });
    const res = await call(app, "zip", { path: "/d" });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/zip");
    const body = new Uint8Array(await res.arrayBuffer());
    // ZIP の署名
    expect([body[0], body[1], body[2], body[3]]).toEqual([0x50, 0x4b, 0x03, 0x04]);
  });

  /** **413 のステータスと本文を固定する**（M4 で「変異させても緑」だった箇所） */
  it("上限を超えたら 413 と件数・バイト数・上限を返す", async () => {
    const app = appWith(
      {
        list: {
          "/d": {
            entries: [entry("a", { size: 5000 })],
            hasMore: false,
            canContinue: false
          }
        }
      },
      { zip: 100 }
    );
    const res = await call(app, "zip", { path: "/d" });
    expect(res.status).toBe(413);
    expect(await res.json()).toMatchObject({
      code: "TOO_LARGE",
      bytes: 5000,
      maxBytes: 100,
      partial: true
    });
  });

  /** 欠けた zip を黙って返さない（decisions D6） */
  it("一覧を辿り切れないなら 409 で、辿れなかったパスを伝える", async () => {
    const app = appWith({
      list: { "/QSYS.LIB": { entries: [entry("a")], hasMore: true, canContinue: false } }
    });
    const res = await call(app, "zip", { path: "/QSYS.LIB" });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({
      code: "INCOMPLETE_LISTING",
      path: "/QSYS.LIB"
    });
  });

  /** ディレクトリ数の超過は**別のコード**で返す（03 が本文の形で分岐せずに済むように） */
  it("ディレクトリが多すぎるときは TOO_MANY_DIRECTORIES", async () => {
    const app = appWith(
      {
        list: {
          "/d": { entries: [entry("s", { isDirectory: true })], hasMore: false, canContinue: false }
        }
      },
      { dirs: 1 }
    );
    const res = await call(app, "zip", { path: "/d" });
    expect(res.status).toBe(413);
    expect(await res.json()).toMatchObject({ code: "TOO_MANY_DIRECTORIES" });
  });

  /**
   * 列挙時のサイズと実際の読み取りが食い違った場合。
   * **列挙段で超えたときと同じ 413** にする（利用者から見て同じ事象なので）。
   */
  it("読み取り中に上限を超えても 413（400 にしない）", async () => {
    const app = appWith(
      {
        list: { "/d": { entries: [entry("a", { size: 1 })], hasMore: false, canContinue: false } },
        // 一覧は 1 バイトと言うが、実際は 500 バイト
        files: { "/d/a": new Uint8Array(500) }
      },
      { zip: 100 }
    );
    const res = await call(app, "zip", { path: "/d" });
    expect(res.status).toBe(413);
    expect(await res.json()).toMatchObject({ code: "TOO_LARGE", partial: true });
  });

  it("上限を超えるとき中身を読まない", async () => {
    const calls: string[] = [];
    const app = appWith(
      {
        calls,
        list: {
          "/d": { entries: [entry("a", { size: 5000 })], hasMore: false, canContinue: false }
        }
      },
      { zip: 100 }
    );
    await call(app, "zip", { path: "/d" });
    expect(calls.filter((x) => x.startsWith("read"))).toEqual([]);
  });
});
