import { describe, it, expect } from "vitest";
import { Hono } from "hono";
import { As400Error, type DtaqConnection, type DtaqEntry, type DtaqAttributes } from "@as400web/core";
import type { AuthVars } from "../src/auth.js";
import { ConfigResolver } from "../src/config-resolver.js";
import { PersonalConfigStore, ServerConfigStore } from "../src/config-store.js";
import { registerHostDtaqRoutes } from "../src/host-dtaq.js";

/**
 * **ルートのハンドラ本体を実際に通す**（IFS の M4 と同じ方針）。
 * 偽の接続を差し込んで、encoding 変換・wait クランプ・空の扱い・エラー写像・senderInfo の
 * デコードを固定する。入力検証と純関数しか通らない「緑」を避ける。
 */

interface FakeOpts {
  /** read が返すエントリ列（順に消費）。空配列 → undefined（空キュー） */
  reads?: (DtaqEntry | undefined)[];
  attributes?: DtaqAttributes;
  fail?: As400Error;
  /** 呼ばれた操作を記録する */
  calls?: string[];
}

function fakeConn(opts: FakeOpts): DtaqConnection {
  let readIdx = 0;
  const conn = {
    async write(name: string, library: string, entry: Uint8Array, key?: Uint8Array): Promise<void> {
      opts.calls?.push(`write ${library}/${name} ${entry.length} key=${key ? key.length : 0}`);
      if (opts.fail) throw opts.fail;
    },
    async read(o: { wait: number; peek?: boolean; key?: Uint8Array; search?: string }): Promise<DtaqEntry | undefined> {
      opts.calls?.push(`read wait=${o.wait} peek=${o.peek ?? false} key=${o.key ? o.key.length : 0} search=${o.search ?? "-"}`);
      if (opts.fail) throw opts.fail;
      return opts.reads?.[readIdx++];
    },
    async create(): Promise<void> {
      opts.calls?.push("create");
      if (opts.fail) throw opts.fail;
    },
    async clear(name: string, library: string, key?: Uint8Array): Promise<void> {
      opts.calls?.push(`clear ${library}/${name} key=${key ? key.length : 0}`);
      if (opts.fail) throw opts.fail;
    },
    async deleteQueue(): Promise<void> {
      opts.calls?.push("delete");
      if (opts.fail) throw opts.fail;
    },
    async attributes(): Promise<DtaqAttributes> {
      opts.calls?.push("attributes");
      if (opts.fail) throw opts.fail;
      return opts.attributes ?? { maxEntryLength: 100, type: "FIFO", keyLength: 0, saveSender: false };
    },
    close(): void {
      opts.calls?.push("close");
    }
  };
  return conn as unknown as DtaqConnection;
}

function appWith(opts: FakeOpts, receiveMaxWaitSec = 60) {
  const app = new Hono<{ Variables: AuthVars }>();
  const server = new ServerConfigStore({
    systems: [{ id: "s", name: "s", host: "example.invalid" }],
    sessions: []
  });
  registerHostDtaqRoutes(app, {
    resolver: new ConfigResolver(server, new PersonalConfigStore()),
    receiveMaxWaitSec,
    connect: async () => fakeConn(opts)
  });
  return app;
}

const SOURCE = { system: "srv:s" };

async function call(app: ReturnType<typeof appWith>, route: string, body: unknown) {
  return app.request(`/api/host/dtaq/${route}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ source: SOURCE, ...(body as object) })
  });
}

describe("send", () => {
  it("utf8 テキストをバイト列にして write する", async () => {
    const calls: string[] = [];
    const res = await call(appWith({ calls }), "send", {
      library: "MYLIB",
      name: "Q",
      data: "hello"
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(calls).toContain("write MYLIB/Q 5 key=0");
  });

  it("base64 はバイナリとして復号する", async () => {
    const calls: string[] = [];
    // "AAECAwQ=" = 5 bytes
    await call(appWith({ calls }), "send", {
      library: "MYLIB",
      name: "Q",
      data: "AAECAwQ=",
      encoding: "base64"
    });
    expect(calls).toContain("write MYLIB/Q 5 key=0");
  });

  it("キー付きは key も変換して渡す", async () => {
    const calls: string[] = [];
    await call(appWith({ calls }), "send", {
      library: "MYLIB",
      name: "Q",
      data: "v",
      key: "0010"
    });
    expect(calls.some((c) => c.startsWith("write MYLIB/Q 1 key=4"))).toBe(true);
  });

  it("キュー名が 10 文字を超えると 400", async () => {
    const res = await call(appWith({}), "send", { library: "MYLIB", name: "TOOLONGNAME11", data: "x" });
    expect(res.status).toBe(400);
  });

  it("不正な base64 は 400（黙って切り詰めない）", async () => {
    const calls: string[] = [];
    // "!!!!" は base64 の文字集合外。Buffer.from は無視して 0 バイトにするので明示的に弾く
    const res = await call(appWith({ calls }), "send", {
      library: "MYLIB",
      name: "Q",
      data: "!!!!",
      encoding: "base64"
    });
    expect(res.status).toBe(400);
    // 変換で弾くので write までは進まない
    expect(calls.some((x) => x.startsWith("write"))).toBe(false);
  });
});

describe("receive", () => {
  it("空キューは entry:null（エラーにしない）", async () => {
    const res = await call(appWith({ reads: [undefined] }), "receive", { library: "MYLIB", name: "Q" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ entry: null });
  });

  it("entry.data を要求 encoding で返し、senderInfo はデコードして返す", async () => {
    // senderInfo は EBCDIC。0xC1=A, 0xC2=B（CCSID273）
    const entry: DtaqEntry = {
      data: new TextEncoder().encode("hello"),
      senderInfo: Uint8Array.from([0xc1, 0xc2, 0x40, 0x40])
    };
    const res = await call(appWith({ reads: [entry] }), "receive", { library: "MYLIB", name: "Q" });
    const body = (await res.json()) as { entry: { data: string; bytes: number; senderInfo?: string } };
    expect(body.entry.data).toBe("hello");
    expect(body.entry.bytes).toBe(5);
    expect(body.entry.senderInfo).toBe("AB");
  });

  it("encoding=ebcdic はシステム CCSID(273) で data をデコードして返す", async () => {
    // EBCDIC273 の 0xC1 0xC2 は "AB"。utf8 デコードなら別物になるので、経路を判別できる
    const entry: DtaqEntry = { data: Uint8Array.from([0xc1, 0xc2]) };
    const res = await call(appWith({ reads: [entry] }), "receive", {
      library: "MYLIB",
      name: "Q",
      encoding: "ebcdic"
    });
    const body = (await res.json()) as { entry: { data: string; encoding: string } };
    expect(body.entry.data).toBe("AB");
    expect(body.entry.encoding).toBe("ebcdic");
  });

  it("wait を上限でクランプする（無限待ちを HTTP から作らせない）", async () => {
    const calls: string[] = [];
    await call(appWith({ calls, reads: [undefined] }, 30), "receive", {
      library: "MYLIB",
      name: "Q",
      wait: 999
    });
    expect(calls.some((c) => c.startsWith("read wait=30"))).toBe(true);
  });

  it("負の wait は 400（無限待ちは弾く）", async () => {
    const res = await call(appWith({}), "receive", { library: "MYLIB", name: "Q", wait: -1 });
    expect(res.status).toBe(400);
  });

  it("キー検索は key と search を渡す", async () => {
    const calls: string[] = [];
    await call(appWith({ calls, reads: [undefined] }), "receive", {
      library: "MYLIB",
      name: "Q",
      key: "0020",
      search: "GE",
      peek: true
    });
    expect(calls.some((c) => c.includes("key=4 search=GE") && c.includes("peek=true"))).toBe(true);
  });
});

describe("create", () => {
  it("KEYED で keyLength 無しは 400", async () => {
    const res = await call(appWith({}), "create", {
      library: "MYLIB",
      name: "Q",
      maxEntryLength: 100,
      type: "KEYED"
    });
    expect(res.status).toBe(400);
  });

  it("非 KEYED で keyLength ありは 400", async () => {
    const res = await call(appWith({}), "create", {
      library: "MYLIB",
      name: "Q",
      maxEntryLength: 100,
      type: "FIFO",
      keyLength: 4
    });
    expect(res.status).toBe(400);
  });

  it("maxEntryLength の上限（64512 超）は 400", async () => {
    const res = await call(appWith({}), "create", {
      library: "MYLIB",
      name: "Q",
      maxEntryLength: 70000,
      type: "FIFO"
    });
    expect(res.status).toBe(400);
  });

  it("FIFO 作成は 200", async () => {
    const calls: string[] = [];
    const res = await call(appWith({ calls }), "create", {
      library: "MYLIB",
      name: "Q",
      maxEntryLength: 100,
      type: "FIFO"
    });
    expect(res.status).toBe(200);
    expect(calls).toContain("create");
  });
});

describe("attributes / clear / delete", () => {
  it("attributes をそのまま返す", async () => {
    const attrs: DtaqAttributes = { maxEntryLength: 333, type: "KEYED", keyLength: 7, saveSender: true };
    const res = await call(appWith({ attributes: attrs }), "attributes", { library: "MYLIB", name: "Q" });
    expect(await res.json()).toEqual(attrs);
  });

  it("clear はキーを渡せる", async () => {
    const calls: string[] = [];
    await call(appWith({ calls }), "clear", { library: "MYLIB", name: "Q", key: "0010" });
    expect(calls.some((c) => c.startsWith("clear MYLIB/Q key=4"))).toBe(true);
  });

  it("delete は 200", async () => {
    const res = await call(appWith({}), "delete", { library: "MYLIB", name: "Q" });
    expect(res.status).toBe(200);
  });
});

describe("エラー写像（core の As400Error → HTTP ステータス）", () => {
  const cases: [string, 400 | 403 | 404 | 409][] = [
    ["NOT_FOUND", 404],
    ["ACCESS_DENIED", 403],
    ["ALREADY_EXISTS", 409],
    ["CONFIG_ERROR", 400]
  ];
  for (const [code, status] of cases) {
    it(`${code} → ${status}`, async () => {
      const res = await call(appWith({ fail: new As400Error(code as never, "boom") }), "attributes", {
        library: "MYLIB",
        name: "Q"
      });
      expect(res.status).toBe(status);
    });
  }

  it("PROTOCOL_ERROR は 502（上流の失敗）", async () => {
    const res = await call(appWith({ fail: new As400Error("PROTOCOL_ERROR", "boom") }), "delete", {
      library: "MYLIB",
      name: "Q"
    });
    expect(res.status).toBe(502);
  });

  it("失敗しても接続は閉じる", async () => {
    const calls: string[] = [];
    await call(appWith({ calls, fail: new As400Error("PROTOCOL_ERROR", "x") }), "delete", {
      library: "MYLIB",
      name: "Q"
    });
    expect(calls).toContain("close");
  });
});
