import { describe, it, expect } from "vitest";
import { Hono } from "hono";
import { codecForCcsid } from "@ts5250/ebcdic";
import {
  stringToPackedDecimal,
  type CommandConnection,
  type IfsConnection,
  type ProgramParameter
} from "@ts5250/hostserver";
import type { AuthVars } from "../src/auth.js";
import { ConfigResolver } from "../src/config-resolver.js";
import { PersonalConfigStore, ServerConfigStore } from "../src/config-store.js";
import { registerHostPcmlRoutes } from "../src/host-pcml.js";

/**
 * **記述から呼ぶ経路**（`/api/host/pcml/*`）。
 *
 * ここで使う PCML は**実機のコンパイラが吐いたそのもの**——SR-OSAKA で
 * `CRTBNDRPG ... PGMINFO(*PCML)` を通して得た。手で整えると
 * 「実機が吐かない形」を通してしまう。
 */
const PCML = `<pcml version="6.0">
   <!-- RPG program: PCMLTST  -->
   <struct name="CUSTT">
      <data name="ID" type="packed" length="7" precision="0" usage="inherit" />
      <data name="NM" type="char" length="20" usage="inherit" />
      <data name="RATE" type="packed" length="9" precision="4" usage="inherit" />
   </struct>
   <program name="PCMLTST" path="/QSYS.LIB/ASAOLIB.LIB/PCMLTST.PGM">
      <data name="INTXT" type="char" length="10" usage="input" />
      <data name="IONUM" type="packed" length="9" precision="2" usage="inputoutput" />
      <data name="REC" type="struct" struct="CUSTT" usage="inputoutput" />
      <data name="CNT" type="int" length="4" precision="31" usage="inputoutput" />
   </program>
</pcml>`;

const cp = codecForCcsid(37);

interface FakeOpts {
  /** 呼ばれたパラメータを記録する */
  seen?: ProgramParameter[][];
  /** 返す出力（引数の並び） */
  outputs?: (Uint8Array | undefined)[];
  files?: Record<string, { data: Uint8Array; ccsid?: number }>;
  target?: string[];
}

function fakeCommand(opts: FakeOpts): CommandConnection {
  return {
    async call(program: string, library: string, params: ProgramParameter[]) {
      opts.target?.push(`${library}/${program}`);
      opts.seen?.push(params);
      return {
        result: { success: true, returnCode: 0, messages: [] },
        outputs: opts.outputs ?? []
      };
    },
    close(): void {}
  } as unknown as CommandConnection;
}

function fakeIfs(opts: FakeOpts): IfsConnection {
  return {
    async readTextFile(path: string) {
      const got = opts.files?.[path];
      if (!got) throw new Error(`no such file: ${path}`);
      return got;
    },
    close(): void {}
  } as unknown as IfsConnection;
}

function appWith(opts: FakeOpts) {
  const app = new Hono<{ Variables: AuthVars }>();
  const server = new ServerConfigStore({
    systems: [{ id: "s", name: "s", host: "example.invalid" }],
    sessions: []
  });
  registerHostPcmlRoutes(app, {
    resolver: new ConfigResolver(server, new PersonalConfigStore()),
    connect: async () => fakeCommand(opts),
    connectIfs: async () => fakeIfs(opts)
  });
  return app;
}

const SOURCE = { system: "srv:s" };

const post = async (app: Hono<{ Variables: AuthVars }>, route: string, body: unknown) =>
  app.request(`/api/host/pcml/${route}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });

/** 全ての入力を埋めた値（足りないと断られる） */
const VALUES = {
  "PCMLTST.INTXT": "HELLO",
  "PCMLTST.IONUM": "12.34",
  "PCMLTST.REC.ID": "0",
  "PCMLTST.REC.NM": "",
  "PCMLTST.REC.RATE": "0",
  "PCMLTST.CNT": "0"
};

describe("parse", () => {
  it("本文から界面を返す", async () => {
    const res = await post(appWith({}), "parse", { text: PCML });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { version: string; programs: { name: string; fields: unknown[] }[] };
    expect(body.version).toBe("6.0");
    expect(body.programs[0]?.name).toBe("PCMLTST");
    expect(body.programs[0]?.fields).toHaveLength(4);
  });

  it("**構造体は入れ子のまま返す**（画面が組み立てられるように）", async () => {
    const res = await post(appWith({}), "parse", { text: PCML });
    const body = (await res.json()) as {
      programs: { fields: { name: string; fields?: { name: string; path: string }[] }[] }[];
    };
    const rec = body.programs[0]!.fields[2]!;
    expect(rec.fields?.map((f) => f.name)).toEqual(["ID", "NM", "RATE"]);
    expect(rec.fields?.[1]?.path).toBe("PCMLTST.REC.NM");
  });

  it("**IFS から読む**（コンパイラが吐いた場所）", async () => {
    const bytes = new Uint8Array([...PCML].map((c) => c.charCodeAt(0)));
    const app = appWith({ files: { "/home/x/a.pcml": { data: bytes, ccsid: 819 } } });
    const res = await post(app, "parse", { source: SOURCE, path: "/home/x/a.pcml" });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { version: string }).version).toBe("6.0");
  });

  it("UTF-8 で置き直されていても読める", async () => {
    const bytes = new TextEncoder().encode(PCML);
    const app = appWith({ files: { "/a": { data: bytes, ccsid: 1208 } } });
    const res = await post(app, "parse", { source: SOURCE, path: "/a" });
    expect(res.status).toBe(200);
  });

  it("**path で読むには接続が要る**", async () => {
    const res = await post(appWith({}), "parse", { path: "/a" });
    expect(res.status).not.toBe(200);
    expect(((await res.json()) as { error: string }).error).toMatch(/接続の指定が要ります/u);
  });

  it("どちらも無ければ断る", async () => {
    const res = await post(appWith({}), "parse", {});
    expect(((await res.json()) as { error: string }).error).toMatch(/text か path/u);
  });

  it("**壊れた記述は行番号つきで返る**", async () => {
    const res = await post(appWith({}), "parse", { text: '<pcml version="1.0">\n<program name="A">\n' });
    expect(((await res.json()) as { error: string }).error).toMatch(/2 行目/u);
  });
});

describe("call", () => {
  it("**記述どおりのパラメータで呼ぶ**（構造体は 1 本にまとまる）", async () => {
    const seen: ProgramParameter[][] = [];
    const target: string[] = [];
    const app = appWith({ seen, target, outputs: [] });
    const res = await post(app, "call", { source: SOURCE, text: PCML, program: "PCMLTST", values: VALUES });
    expect(res.status).toBe(200);

    const params = seen[0]!;
    expect(params).toHaveLength(4);
    expect(params.map((p) => ("data" in p ? p.data.length : "length" in p ? p.length : 0))).toEqual([
      10, 5, 29, 4
    ]);
    // **入力専用は in、それ以外は inout**
    expect(params.map((p) => p.type)).toEqual(["in", "inout", "inout", "inout"]);
    // path からライブラリを解いている
    expect(target[0]).toBe("ASAOLIB/PCMLTST");
    expect(((await res.json()) as { called: string }).called).toBe("ASAOLIB/PCMLTST");
  });

  it("**結果は名前で返る**（構造体の中も）", async () => {
    const rec = new Uint8Array(29);
    rec.set(stringToPackedDecimal("7", 7, 0), 0);
    rec.set(cp.encode("REC:HELLO".padEnd(20)).bytes, 4);
    rec.set(stringToPackedDecimal("1.5", 9, 4), 24);
    const app = appWith({
      outputs: [undefined, stringToPackedDecimal("24.68", 9, 2), rec, new Uint8Array([0, 0, 0, 4])]
    });
    const res = await post(app, "call", { source: SOURCE, text: PCML, program: "PCMLTST", values: VALUES });
    const body = (await res.json()) as { values: Record<string, string> };
    expect(body.values["PCMLTST.IONUM"]).toBe("24.68");
    expect(body.values["PCMLTST.REC.ID"]).toBe("7");
    expect(body.values["PCMLTST.REC.NM"]?.trim()).toBe("REC:HELLO");
    expect(body.values["PCMLTST.CNT"]).toBe("4");
    // 入力専用は返らない
    expect(body.values["PCMLTST.INTXT"]).toBeUndefined();
  });

  it("**足りない入力は、どの項目かを言って断る**", async () => {
    const partial = { ...VALUES } as Record<string, string>;
    delete partial["PCMLTST.REC.NM"];
    const res = await post(appWith({}), "call", {
      source: SOURCE,
      text: PCML,
      program: "PCMLTST",
      values: partial
    });
    expect(res.status).not.toBe(200);
    expect(((await res.json()) as { error: string }).error).toMatch(/PCMLTST\.REC\.NM/u);
  });

  it("知らないプログラム名は、あるものを挙げて断る", async () => {
    const res = await post(appWith({}), "call", { source: SOURCE, text: PCML, program: "NOPE" });
    expect(((await res.json()) as { error: string }).error).toMatch(/あるのは: PCMLTST/u);
  });

  it("**サービスプログラムは黙って *PGM として呼ばない**", async () => {
    const text = PCML.replace('path="/QSYS.LIB/ASAOLIB.LIB/PCMLTST.PGM"', 'entrypoint="SOMEPROC"');
    const res = await post(appWith({}), "call", {
      source: SOURCE,
      text,
      program: "PCMLTST",
      values: VALUES
    });
    expect(((await res.json()) as { error: string }).error).toMatch(/サービスプログラム/u);
  });
});
