import { describe, it, expect, vi, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Hono } from "hono";
import type { CommandConnection } from "@ts5250/hostserver";
import type { AuthVars } from "../src/auth.js";
import { ConfigResolver } from "../src/config-resolver.js";
import { PersonalConfigStore, ServerConfigStore } from "../src/config-store.js";
import { registerHostCommandRoutes } from "../src/host-command.js";
import * as hostConnect from "../src/host-connect.js";

/**
 * **コマンドのプロンプト**（`/api/host/command/*`）。
 *
 * 偽の接続を差し込んで**ハンドラ本体を通す**。見るのは配線ではなく振る舞い——
 * 空欄を送らないこと（＝ホストの既定に任せる）、組んだ文字列を返すこと、
 * 検証がサーバー側で効くこと。
 */

const here = dirname(fileURLToPath(import.meta.url));
// **実機から採った本物の定義**を使う（hostserver のテストと同じ fixture）
const XML = readFileSync(join(here, "..", "..", "hostserver", "test", "fixtures", "cmdd-crtlib.xml"), "utf8");

function fakeConn(ran: string[]): CommandConnection {
  const bytes = new TextEncoder().encode(XML);
  return {
    async call(_p: string, _l: string, params: readonly { type: string; length?: number }[]) {
      // 受信変数は 4 番目。1 回目は 8 バイト（長さを聞くだけ）、2 回目に本体
      const recv = params[3]!;
      const want = recv.length ?? 0;
      const out = new Uint8Array(Math.max(8, want));
      const dv = new DataView(out.buffer);
      if (want <= 8) {
        dv.setInt32(0, 0);
        dv.setInt32(4, bytes.length);
      } else {
        dv.setInt32(0, bytes.length);
        dv.setInt32(4, bytes.length);
        out.set(bytes, 8);
      }
      return { result: { success: true, returnCode: 0, messages: [] }, outputs: [undefined, undefined, undefined, out, undefined, undefined] };
    },
    async run(command: string) {
      ran.push(command);
      return { success: true, returnCode: 0, messages: [{ id: "CPC2102", text: "created", severity: 0, kind: "completion" }] };
    },
    close(): void {}
  } as unknown as CommandConnection;
}

function appWith(ran: string[]) {
  vi.spyOn(hostConnect, "openCommand").mockResolvedValue(fakeConn(ran) as never);
  const app = new Hono<{ Variables: AuthVars }>();
  const server = new ServerConfigStore({
    systems: [{ id: "s", name: "s", host: "example.invalid" }],
    sessions: []
  });
  registerHostCommandRoutes(app, { resolver: new ConfigResolver(server, new PersonalConfigStore()) });
  return app;
}

const post = async (app: Hono<{ Variables: AuthVars }>, route: string, body: unknown) =>
  app.request(`/api/host/command/${route}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });

const SOURCE = { system: "srv:s" };
afterEach(() => vi.restoreAllMocks());

describe("コマンドのテンプレート", () => {
  it("**定義を型どおりに返す**", async () => {
    const res = await post(appWith([]), "template", { source: SOURCE, command: "CRTLIB" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { name: string; parameters: { keyword: string; required: boolean }[] };
    expect(body.name).toBe("CRTLIB");
    expect(body.parameters.find((p) => p.keyword === "LIB")!.required).toBe(true);
  });

  it("**生の XML は返さない**（12KB 級になるうえ UI は使わない）", async () => {
    const res = await post(appWith([]), "template", { source: SOURCE, command: "CRTLIB" });
    expect(await res.text()).not.toContain("QcdCLCmd");
  });
});

describe("コマンドの実行", () => {
  it("**組んで実行し、走った文字列を返す**", async () => {
    const ran: string[] = [];
    const res = await post(appWith(ran), "run", {
      source: SOURCE,
      command: "CRTLIB",
      values: { LIB: "TESTLIB", TEXT: "It's a test" }
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { command: string; success: boolean };
    expect(body.command).toBe("CRTLIB LIB(TESTLIB) TEXT('It''s a test')");
    expect(ran).toEqual([body.command]);
    expect(body.success).toBe(true);
  });

  it("**空欄は送らない**——ホストの既定に任せる", async () => {
    const ran: string[] = [];
    await post(appWith(ran), "run", {
      source: SOURCE,
      command: "CRTLIB",
      values: { LIB: "L", TYPE: "", TEXT: "   " }
    });
    expect(ran[0]).toBe("CRTLIB LIB(L)");
  });

  it("**組むだけの口は実行しない**（実行前に目で確かめるため）", async () => {
    const ran: string[] = [];
    const res = await post(appWith(ran), "build", {
      source: SOURCE,
      command: "CRTLIB",
      values: { LIB: "L", TEXT: "a b" }
    });
    expect(res.status).toBe(200);
    expect((await res.json()).command).toBe("CRTLIB LIB(L) TEXT('a b')");
    expect(ran, "組むだけのはずが実行されている").toEqual([]);
  });

  it("**許されない値はサーバーで弾く**（ホストへ行かせない）", async () => {
    const ran: string[] = [];
    const res = await post(appWith(ran), "run", {
      source: SOURCE,
      command: "CRTLIB",
      values: { LIB: "L", TYPE: "*BOGUS" }
    });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect((await res.json()).error).toContain("accepts only");
    expect(ran, "弾いたのに実行してしまっている").toEqual([]);
  });

  it("**必須の抜けもサーバーで弾く**", async () => {
    const ran: string[] = [];
    const res = await post(appWith(ran), "run", { source: SOURCE, command: "CRTLIB", values: { TEXT: "x" } });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect((await res.json()).error).toContain("requires LIB");
    expect(ran).toEqual([]);
  });
});
