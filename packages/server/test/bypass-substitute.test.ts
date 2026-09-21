import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * **自動サインオンの代替パスワードの関数**（`bypassSubstituteFor`。`20260921-encrypted-autosignon`）。
 * QPWDLVL はサインオン・サーバーに聞き（1 回だけ）、聞けなければ 0（ACS も 0）。計算は hostserver の `bypassSignonSubstitute`。
 */
const levels: (number | Error)[] = [];
const calls: { level: number; user: string; password: string }[] = [];
let queries = 0;
vi.mock("@ts5250/hostserver", async (orig) => ({
  ...(await orig<typeof import("@ts5250/hostserver")>()),
  querySignonInfo: async () => {
    queries++;
    const l = levels.shift() ?? 3;
    if (l instanceof Error) throw l;
    return { passwordLevel: l };
  },
  bypassSignonSubstitute: async (level: number, user: string, password: string) => {
    calls.push({ level, user, password });
    return new Uint8Array(level >= 2 ? 20 : 8);
  }
}));
const { bypassSubstituteFor, SessionManager } = await import("../src/session-manager.js");
import type { Transport } from "@ts5250/tn5250";

beforeEach(() => {
  levels.splice(0);
  calls.splice(0);
  queries = 0;
});
const seed = new Uint8Array(8);

describe("bypassSubstituteFor", () => {
  it("利用者名・パスワードが無ければ作らない（従来どおり平文の経路も無い）", () => {
    expect(bypassSubstituteFor({ host: "h", user: "u" })).toBeUndefined();
    expect(bypassSubstituteFor({ host: "h", password: "p" })).toBeUndefined();
  });

  it("**サインオン・サーバーの QPWDLVL で計算し、問い合わせは 1 回だけ**。利用者名は大文字、パスワードは末尾の空白を落とす", async () => {
    levels.push(3);
    const f = bypassSubstituteFor({ host: "h", user: " alice ", password: "Secret  " })!;
    const a = await f(seed);
    await f(seed); // 装置名の答え直しなどでもう一度聞かれた
    expect(queries).toBe(1);
    expect(calls[0]).toEqual({ level: 3, user: "ALICE", password: "Secret" });
    expect(a.clientSeed).toHaveLength(8);
    expect(a.substitute).toHaveLength(20);
  });

  it("**聞けなければ 0**（ACS も 0 にして DES で計算する）", async () => {
    levels.push(new Error("ECONNREFUSED"));
    const f = bypassSubstituteFor({ host: "h", user: "u", password: "p" })!;
    const r = await f(seed);
    expect(calls[0]!.level).toBe(0);
    expect(r.substitute).toHaveLength(8);
  });

  it("クライアントのシードは毎回違う（乱数）", async () => {
    const f = bypassSubstituteFor({ host: "h", user: "u", password: "p" })!;
    const [a, b] = [await f(seed), await f(seed)];
    expect([...a.clientSeed]).not.toEqual([...b.clientSeed]);
  });
});

describe("SessionManager が自動サインオンを暗号化して送る", () => {
  // ホストの SEND（USERVAR IBMRSEED <シード 8 バイト>）
  const SEND = [0xff, 0xfa, 0x27, 0x01, 0x03, ...[..."IBMRSEED"].map((c) => c.charCodeAt(0)), 1, 2, 3, 4, 5, 6, 7, 8, 0xff, 0xf0];
  function capturing(): { transport: Transport; text: () => string } {
    let onData: ((d: Uint8Array) => void) | undefined;
    const sent: number[] = [];
    const transport = {
      onData: (cb: (d: Uint8Array) => void) => void (onData = cb),
      onClose: () => {},
      onError: () => {},
      send: (d: Uint8Array) => void sent.push(...d),
      close: () => {},
      start: () => onData?.(Uint8Array.from(SEND))
    } as unknown as Transport;
    return { transport, text: () => String.fromCharCode(...sent) };
  }

  it("表示: IBMSUBSPW は代替パスワード（平文のパスワードは送らない）", async () => {
    const { transport, text } = capturing();
    const mgr = new SessionManager();
    await mgr.open({ transport, host: "h", user: "alice", password: "Secret9", negotiationTimeoutMs: 150 }).catch(() => {});
    expect(calls[0]).toMatchObject({ user: "ALICE", password: "Secret9" });
    expect(text()).toContain("IBMSUBSPW");
    expect(text()).not.toContain("Secret9");
    mgr.closeAll();
  });

  it("プリンターも同じ", async () => {
    const { transport, text } = capturing();
    const mgr = new SessionManager();
    await mgr.openPrinter({ transport, host: "h", user: "bob", password: "Secret9", negotiationTimeoutMs: 150 }).catch(() => {});
    expect(calls[0]).toMatchObject({ user: "BOB" });
    expect(text()).not.toContain("Secret9");
    mgr.closeAll();
  });
});
