/**
 * WS 接続の寿命（在席の合図・ハートビート・タイムアウト設定の転記）。
 *
 * アイドルタイムアウトの既定が**永続**になったので、孤児を回収するのは
 * ①`onSocketClose` と ②ハートビート（半開きソケット）の 2 つだけになった。
 * どちらが欠けても「閉じないセッション」が残る（`20260729-session-lifetime-timeout`）。
 */
import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { ReplayTransport, parseTraceJsonl, type Transport } from "@as400web/core";
import { WsConnection } from "../src/ws-handler.js";
import { SessionManager, type OpenOptions, type OpenPrinterOptions } from "../src/session-manager.js";
import { ConfigResolver } from "../src/config-resolver.js";
import { PersonalConfigStore, ServerConfigStore } from "../src/config-store.js";
import type { WsServerMessage } from "../src/ws-messages.js";

const here = dirname(fileURLToPath(import.meta.url));
const fixtureDir = join(here, "..", "..", "core", "test", "fixtures");
const signon = () => parseTraceJsonl(readFileSync(join(fixtureDir, "pub400-signon.jsonl"), "utf8"));

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

/** open / openPrinter に渡ったオプションを覗ける Manager */
class SpyManager extends SessionManager {
  readonly openOpts: OpenOptions[] = [];
  readonly printerOpts: OpenPrinterOptions[] = [];
  readonly touched: string[] = [];
  override open(opts: OpenOptions) {
    this.openOpts.push(opts);
    return super.open({ ...opts, transport: new ReplayTransport(signon()) });
  }
  override openPrinter(opts: OpenPrinterOptions) {
    this.printerOpts.push(opts);
    return super.openPrinter({ ...opts, transport: new PrinterTransport() });
  }
  override touch(id: string): void {
    this.touched.push(id);
    super.touch(id);
  }
}

/**
 * 「無操作で切る」を設定したサーバー設定を持つ環境を組む。
 * display / printer の 2 本を同じ値で用意し、**プリンター経路の転記漏れ**を突けるようにする。
 */
function setup(opts: { idleTimeout?: "never" | number; hb?: { intervalMs?: number; deadMs?: number; now?: () => number } } = {}) {
  const sent: WsServerMessage[] = [];
  let closed = false;
  const mgr = new SpyManager();
  const idle = opts.idleTimeout !== undefined ? { idleTimeout: opts.idleTimeout } : {};
  const server = new ServerConfigStore({
    systems: [{ id: "sys", name: "sys", host: "h" }],
    sessions: [
      { id: "d", name: "d", system: "sys", sessionType: "display", ...idle },
      { id: "p", name: "p", system: "sys", sessionType: "printer", ...idle }
    ]
  });
  const resolver = new ConfigResolver(server, new PersonalConfigStore());
  const conn = new WsConnection(
    { sessions: mgr, resolver },
    {
      send: (d) => sent.push(JSON.parse(d) as WsServerMessage),
      close: () => {
        closed = true;
      }
    },
    undefined,
    opts.hb ?? {}
  );
  return { conn, sent, mgr, isClosed: () => closed };
}

describe("設定の転記: 表示・プリンターの両方に効く", () => {
  it("表示セッションの idleTimeout（分）が ms で open に届く", async () => {
    const { conn, mgr } = setup({ idleTimeout: 30 });
    await conn.handle(JSON.stringify({ type: "open", session: "srv:d" }));
    expect(mgr.openOpts[0]?.idleTimeoutMs).toBe(30 * 60_000);
    mgr.closeAll();
  });

  it('表示セッションの "never" がそのまま届く', async () => {
    const { conn, mgr } = setup({ idleTimeout: "never" });
    await conn.handle(JSON.stringify({ type: "open", session: "srv:d" }));
    expect(mgr.openOpts[0]?.idleTimeoutMs).toBe("never");
    mgr.closeAll();
  });

  it("**プリンターセッションにも届く**（キーごとの手写しなので落ちやすい）", async () => {
    const { conn, mgr } = setup({ idleTimeout: 30 });
    await conn.handle(JSON.stringify({ type: "open", kind: "printer", session: "srv:p" }));
    expect(mgr.printerOpts[0]?.idleTimeoutMs).toBe(30 * 60_000);
    mgr.closeAll();
  });

  it("設定が無ければキーごと付かない（＝サーバー既定に従う）", async () => {
    const { conn, mgr } = setup();
    await conn.handle(JSON.stringify({ type: "open", session: "srv:d" }));
    expect(mgr.openOpts[0]?.idleTimeoutMs).toBeUndefined();
    mgr.closeAll();
  });
});

describe("activity: 在席の合図", () => {
  it("touch が呼ばれる", async () => {
    const { conn, mgr, sent } = setup();
    await conn.handle(JSON.stringify({ type: "open", host: "h" }));
    const opened = sent[0] as { sessionId: string };
    await conn.handle(JSON.stringify({ type: "activity" }));
    expect(mgr.touched).toEqual([opened.sessionId]);
    mgr.closeAll();
  });

  it("open 前の activity は無視する（エラーにしない）", async () => {
    const { conn, mgr, sent } = setup();
    await conn.handle(JSON.stringify({ type: "activity" }));
    expect(mgr.touched).toEqual([]);
    expect(sent).toEqual([]); // error も返さない
  });

  it("応答を返さない（合図に返事は要らない）", async () => {
    const { conn, mgr, sent } = setup();
    await conn.handle(JSON.stringify({ type: "open", host: "h" }));
    const before = sent.length;
    await conn.handle(JSON.stringify({ type: "activity" }));
    expect(sent.length).toBe(before);
    mgr.closeAll();
  });
});

describe("ハートビート", () => {
  it("間隔ごとに ping を送る", async () => {
    vi.useFakeTimers();
    try {
      let t = 0;
      const { conn, mgr, sent } = setup({ hb: { intervalMs: 1000, deadMs: 5000, now: () => t } });
      await conn.handle(JSON.stringify({ type: "open", host: "h" }));
      sent.length = 0;
      t = 1000;
      vi.advanceTimersByTime(1000);
      expect(sent).toEqual([{ type: "ping" }]);
      t = 2000;
      vi.advanceTimersByTime(1000);
      expect(sent).toEqual([{ type: "ping" }, { type: "ping" }]);
      mgr.closeAll();
    } finally {
      vi.useRealTimers();
    }
  });

  it("応答が無いまま deadMs を超えたら破棄して socket を閉じる", async () => {
    vi.useFakeTimers();
    try {
      let t = 0;
      const { conn, mgr, sent, isClosed } = setup({ hb: { intervalMs: 1000, deadMs: 2500, now: () => t } });
      await conn.handle(JSON.stringify({ type: "open", host: "h" }));
      expect(mgr.size).toBe(1);
      sent.length = 0;
      for (const at of [1000, 2000, 3000]) {
        t = at;
        vi.advanceTimersByTime(1000);
      }
      expect(sent.at(-1)).toMatchObject({ type: "closed", reason: "heartbeat timeout" });
      expect(isClosed()).toBe(true);
      expect(mgr.size).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("pong が返っていれば切らない", async () => {
    vi.useFakeTimers();
    try {
      let t = 0;
      const { conn, mgr, isClosed } = setup({ hb: { intervalMs: 1000, deadMs: 2500, now: () => t } });
      await conn.handle(JSON.stringify({ type: "open", host: "h" }));
      for (const at of [1000, 2000, 3000, 4000, 5000]) {
        t = at;
        vi.advanceTimersByTime(1000);
        await conn.handle(JSON.stringify({ type: "pong" }));
      }
      expect(isClosed()).toBe(false);
      expect(mgr.size).toBe(1);
      mgr.closeAll();
    } finally {
      vi.useRealTimers();
    }
  });

  it("**pong 以外の受信でも生き延びる**（キー送信中に心拍だけ落ちても切らない）", async () => {
    vi.useFakeTimers();
    try {
      let t = 0;
      const { conn, mgr, isClosed } = setup({ hb: { intervalMs: 1000, deadMs: 2500, now: () => t } });
      await conn.handle(JSON.stringify({ type: "open", host: "h" }));
      for (const at of [1000, 2000, 3000, 4000]) {
        t = at;
        vi.advanceTimersByTime(1000);
        await conn.handle(JSON.stringify({ type: "activity" }));
      }
      expect(isClosed()).toBe(false);
      expect(mgr.size).toBe(1);
      mgr.closeAll();
    } finally {
      vi.useRealTimers();
    }
  });

  it("open 前は動かない（接続だけで心拍を出さない）", () => {
    vi.useFakeTimers();
    try {
      const { sent } = setup({ hb: { intervalMs: 1000, deadMs: 2500 } });
      vi.advanceTimersByTime(5000);
      expect(sent).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("切断後は心拍が止まる（タイマーの取り残しを作らない）", async () => {
    vi.useFakeTimers();
    try {
      let t = 0;
      const { conn, sent } = setup({ hb: { intervalMs: 1000, deadMs: 5000, now: () => t } });
      await conn.handle(JSON.stringify({ type: "open", host: "h" }));
      conn.onSocketClose();
      sent.length = 0;
      t = 3000;
      vi.advanceTimersByTime(3000);
      expect(sent).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("プリンターセッションでも心拍が動く", async () => {
    vi.useFakeTimers();
    try {
      let t = 0;
      const { conn, mgr, sent } = setup({ hb: { intervalMs: 1000, deadMs: 5000, now: () => t } });
      await conn.handle(JSON.stringify({ type: "open", kind: "printer", session: "srv:p" }));
      sent.length = 0;
      t = 1000;
      vi.advanceTimersByTime(1000);
      expect(sent).toEqual([{ type: "ping" }]);
      mgr.closeAll();
    } finally {
      vi.useRealTimers();
    }
  });
});
