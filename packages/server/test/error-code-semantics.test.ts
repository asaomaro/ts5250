/**
 * エラーコードの**意味**の回帰資産（`20260729-connect-failed-semantics`）。
 *
 * `CONNECT_FAILED`（＝IBM i へ繋げなかった）が server 側で「セッション上限」
 * 「設定ファイルが読めない」「指定不足」にまで広がっていた。受け取った側が
 * **誰が直せる問題か**を判別できなくなるので、意味ごとにコードを分け直した。
 *
 * ここで守るのは「どのコードか」ではなく「**その意味にそのコードが付くか**」。
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { As400Error } from "@as400web/base";
import { ReplayTransport, parseTraceJsonl } from "@as400web/tn5250";
import { statusOf } from "../src/host-api.js";
import { SessionManager } from "../src/session-manager.js";
import { ServerConfigStore, PersonalConfigStore } from "../src/config-store.js";
import { ConfigResolver } from "../src/config-resolver.js";
import { UserStore } from "../src/auth.js";
import type { Transport } from "@as400web/tn5250";

const here = dirname(fileURLToPath(import.meta.url));
const signon = () =>
  parseTraceJsonl(
    readFileSync(join(here, "..", "..", "tn5250", "test", "fixtures", "pub400-signon.jsonl"), "utf8")
  );

/** startup だけ返す最小のプリンター transport */
class PrinterTransport implements Transport {
  private dataFn: ((d: Uint8Array) => void) | undefined;
  send(): void {}
  close(): void {}
  onData(fn: (d: Uint8Array) => void): void {
    this.dataFn = fn;
  }
  onClose(): void {}
  onError(): void {}
  start(): void {
    const body = [0x12, 0xa0, 0x90, 0x00, 0x04, 0x00, 0x00, 0x00, 0, 0, 0, 0, 0, 0xc9, 0xf9, 0xf0, 0xf2];
    const ll = body.length + 2;
    this.dataFn?.(Uint8Array.from([(ll >> 8) & 0xff, ll & 0xff, ...body, 0xff, 0xef]));
  }
}

function tmpFile(name: string, body: string): string {
  const dir = mkdtempSync(join(tmpdir(), "errsem-"));
  const p = join(dir, name);
  writeFileSync(p, body);
  return p;
}

describe("セッション上限は SESSION_LIMIT（繋げなかったのではない）", () => {
  it("表示セッションの上限", async () => {
    const mgr = new SessionManager({ maxSessions: 1 });
    await mgr.open({ transport: new ReplayTransport(signon()) });
    await expect(mgr.open({ transport: new ReplayTransport(signon()) })).rejects.toMatchObject({
      code: "SESSION_LIMIT"
    });
    mgr.closeAll();
  });

  it("プリンターセッションの上限（表示だけ直すのは転記漏れ）", async () => {
    const mgr = new SessionManager({ maxSessions: 1 });
    await mgr.openPrinter({ transport: new PrinterTransport() });
    await expect(mgr.openPrinter({ transport: new PrinterTransport() })).rejects.toMatchObject({
      code: "SESSION_LIMIT"
    });
    mgr.closeAll();
  });

  it("HTTP では 409（**どれか閉じれば通る**。400 でも 502 でもない）", () => {
    expect(statusOf(new As400Error("SESSION_LIMIT", "session limit reached (8)"))).toBe(409);
  });

  it("繋げなかった（CONNECT_FAILED）とは別のコードになっている", async () => {
    const mgr = new SessionManager({ maxSessions: 1 });
    await mgr.open({ transport: new ReplayTransport(signon()) });
    const err = await mgr.open({ transport: new ReplayTransport(signon()) }).catch((e: unknown) => e);
    expect((err as As400Error).code).not.toBe("CONNECT_FAILED");
    mgr.closeAll();
  });
});

describe("設定・指定の不備は CONFIG_ERROR", () => {
  it("設定ファイルが読めない", () => {
    expect(() => ServerConfigStore.fromFile("/nonexistent/profiles.json")).toThrow(
      expect.objectContaining({ code: "CONFIG_ERROR" })
    );
  });

  it("設定ファイルがスキーマ違反", () => {
    const p = tmpFile("profiles.json", JSON.stringify({ systems: [{ id: 1 }] }));
    expect(() => ServerConfigStore.fromFile(p)).toThrow(
      expect.objectContaining({ code: "CONFIG_ERROR" })
    );
  });

  it("平文 signon.password（廃止された書式）", () => {
    const p = tmpFile(
      "profiles.json",
      JSON.stringify({ profiles: [{ name: "x", host: "h", signon: { user: "u", password: "***" } }] })
    );
    expect(() => ServerConfigStore.fromFile(p)).toThrow(
      expect.objectContaining({ code: "CONFIG_ERROR" })
    );
  });

  it("users ファイルが読めない", () => {
    expect(() => UserStore.fromFile("/nonexistent/users.json")).toThrow(
      expect.objectContaining({ code: "CONFIG_ERROR" })
    );
  });

  it("users ファイルがスキーマ違反", () => {
    const p = tmpFile("users.json", JSON.stringify({ users: [{ username: 1 }] }));
    expect(() => UserStore.fromFile(p)).toThrow(expect.objectContaining({ code: "CONFIG_ERROR" }));
  });

  it("接続先の指定が足りない（system / session / host のいずれも無い）", () => {
    const resolver = new ConfigResolver(new ServerConfigStore(), new PersonalConfigStore());
    expect(() => resolver.resolve({}, undefined, () => {})).toThrow(
      expect.objectContaining({ code: "CONFIG_ERROR" })
    );
  });

  it("passwordEnv に指定した環境変数が未設定", () => {
    const store = new ServerConfigStore({
      systems: [{ id: "s", name: "s", host: "h", signon: { user: "u", passwordEnv: "NOPE_UNSET_ENV" } }],
      sessions: []
    });
    const resolver = new ConfigResolver(store, new PersonalConfigStore());
    expect(() => resolver.resolve({ system: "srv:s" }, undefined, () => {})).toThrow(
      expect.objectContaining({ code: "CONFIG_ERROR" })
    );
  });

  it("HTTP では 400 のまま（以前の CONNECT_FAILED と同じ＝API の後方互換）", () => {
    expect(statusOf(new As400Error("CONFIG_ERROR", "x"))).toBe(400);
    expect(statusOf(new As400Error("CONNECT_FAILED", "x"))).toBe(400);
  });
});

/**
 * **不変条件**: 接続は core の仕事なので、server から `CONNECT_FAILED` を投げる筋は無い。
 * 「意味が合っているか」は機械には分からないので、**0 件**という強い形で守る
 * （投げなければ流用も起きない）。
 *
 * **ファイルを列挙せず `src` を丸ごと走査する**——列挙にすると新しいファイルが素通りする。
 */
describe("不変条件: server は CONNECT_FAILED を投げない", () => {
  const SRC = join(here, "..", "src");

  const tsFiles = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
      e.isDirectory() ? tsFiles(join(dir, e.name)) : e.name.endsWith(".ts") ? [join(dir, e.name)] : []
    );

  it("throw する箇所が 1 件も無い（src 全体を走査）", () => {
    const files = tsFiles(SRC);
    expect(files.length).toBeGreaterThan(20); // 走査そのものが空振りしていないこと
    const offenders: string[] = [];
    for (const f of files) {
      const src = readFileSync(f, "utf8");
      // 1 行形式と複数行形式（`new As400Error(\n  "CONNECT_FAILED",`）の両方を拾う
      if (/As400Error\(\s*"CONNECT_FAILED"/.test(src)) offenders.push(relative(SRC, f));
    }
    expect(offenders).toEqual([]);
  });

  it("判定側（statusOf の写像）としては残っている", () => {
    const src = readFileSync(join(SRC, "host-api.ts"), "utf8");
    expect(src).toContain('case "CONNECT_FAILED":');
  });
});
