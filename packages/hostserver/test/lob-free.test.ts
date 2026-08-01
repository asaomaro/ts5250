import { describe, it, expect, afterEach } from "vitest";
import { setLogSink, resetLogSink } from "@as400web/base";
import { freeLob } from "../src/db/lob.js";
import type { DbConnection } from "../src/db/db-connection.js";
import { DB_REQ, DB_CP, ORS } from "../src/db/db-datastream.js";

/**
 * ロケーターの解放（`0x1819`）。
 *
 * **後始末なので投げない**——値は既に取れており、ここで例外にすると
 * 「取れたのに落ちる」ことになる。原典も戻りを読み捨てている。
 *
 * 実機（IBM i 7.3）での実測は
 * `scripts/research-lob-free.mjs` / `20260801-lob-locator-free`:
 * 解放は効き（解放後の取得は `-815`）、**二重解放は `rcClass=2 / -816`**。
 * 原典のコメントが挙げる `7 / -401` とは違う値だった。
 */
type Sent = { reqId: number; orsBitmap?: number; params: { cp: number; value: Uint8Array }[] };

function fakeConn(reply: { rcClass: number; rcClassReturnCode?: number }, sink?: Sent[]): DbConnection {
  return {
    request: async (o: Sent) => {
      sink?.push(o);
      return { dbTemplate: { rcClass: reply.rcClass, rcClassReturnCode: reply.rcClassReturnCode ?? 0 }, params: [] };
    }
  } as unknown as DbConnection;
}

function capture(): { lines: { level: string; message: string }[] } {
  const lines: { level: string; message: string }[] = [];
  const at = (level: string) => (message: string) => void lines.push({ level, message });
  setLogSink(() => ({
    debug: at("debug"),
    info: at("info"),
    warn: at("warn"),
    error: at("error"),
    isDebugEnabled: () => true
  }));
  return { lines };
}

afterEach(() => resetLogSink());

describe("freeLob の要求の形", () => {
  it("ロケーターハンドルだけを送る（原典と同じ）", async () => {
    const sent: Sent[] = [];
    await freeLob(fakeConn({ rcClass: 0 }, sent), 0x1234);

    expect(sent).toHaveLength(1);
    expect(sent[0]!.reqId).toBe(DB_REQ.freeLob);
    expect(sent[0]!.params).toHaveLength(1);
    expect(sent[0]!.params[0]!.cp).toBe(DB_CP.lobLocatorHandle);
    expect([...sent[0]!.params[0]!.value]).toEqual([0x00, 0x00, 0x12, 0x34]);
  });

  it("結果データを要求しない（後始末なので受け取るものが無い）", async () => {
    const sent: Sent[] = [];
    await freeLob(fakeConn({ rcClass: 0 }, sent), 1);
    expect(sent[0]!.orsBitmap).toBe(ORS.sendReplyImmediately);
    // データ形式・結果データのビットは立てない
    expect((sent[0]!.orsBitmap! & ORS.resultData) === 0).toBe(true);
  });
});

describe("freeLob の戻り", () => {
  it("戻りコード 0 なら true", async () => {
    expect(await freeLob(fakeConn({ rcClass: 0 }), 1)).toBe(true);
  });

  it("二重解放（-816）は false だが騒がない", async () => {
    const { lines } = capture();
    expect(await freeLob(fakeConn({ rcClass: 2, rcClassReturnCode: -816 }), 1)).toBe(false);
    // **warn を出さない**——既に解放済みなら目的は達している
    expect(lines.filter((l) => l.level === "warn")).toHaveLength(0);
    expect(lines.some((l) => l.level === "debug" && l.message.includes("既に解放済み"))).toBe(true);
  });

  it("原典が挙げる -401 も同じ扱い（ホスト・版数で値が変わる）", async () => {
    const { lines } = capture();
    expect(await freeLob(fakeConn({ rcClass: 7, rcClassReturnCode: -401 }), 1)).toBe(false);
    expect(lines.filter((l) => l.level === "warn")).toHaveLength(0);
  });

  it("それ以外の失敗は warn で残す（黙って効かないのが一番困る）", async () => {
    const { lines } = capture();
    expect(await freeLob(fakeConn({ rcClass: 2, rcClassReturnCode: -999 }), 7)).toBe(false);
    const warns = lines.filter((l) => l.level === "warn");
    expect(warns).toHaveLength(1);
    expect(warns[0]!.message).toContain("7");
    expect(warns[0]!.message).toContain("-999");
  });

  it("例外は握るが投げ返さない（値は取れているので落とさない）", async () => {
    const { lines } = capture();
    const conn = { request: async () => { throw new Error("socket hang up"); } } as unknown as DbConnection;
    expect(await freeLob(conn, 1)).toBe(false);
    expect(lines.some((l) => l.level === "warn" && l.message.includes("socket hang up"))).toBe(true);
  });
});
