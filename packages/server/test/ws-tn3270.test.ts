import { describe, it, expect } from "vitest";
import { WsConnection } from "../src/ws-handler.js";
import { SessionManager } from "../src/session-manager.js";
import { ConfigResolver } from "../src/config-resolver.js";
import { PersonalConfigStore, ServerConfigStore } from "../src/config-store.js";
import { Tn3270Manager } from "../src/tn3270-manager.js";
import { toAid3270, toWireScreen } from "../src/tn3270-adapt.js";
import type { WsServerMessage } from "../src/ws-messages.js";
import { startMini3270, type Mini3270 } from "../../tn3270/test/harness/mini3270.js";

/**
 * **3270 端末を Web の口から使う**（`terminal: "3270"`）。
 *
 * 相手は `mini3270`——tn3270 側の検証で使っている**最小の 3270 サーバー**で、
 * 指定した 3270 データストリームをそのまま流す。
 * ここで確かめるのは**配管**（開く・画面が来る・キーが届く・5250 の経路を汚さない）で、
 * データストリームの解釈そのものは tn3270 側で s3270 と突き合わせ済み。
 */

/** 保護欄「USER」と非保護欄を持つ画面 */
const SCREEN = Uint8Array.from([
  0xf5, 0xc2, // EraseWrite + WCC restore
  0x11, 0x40, 0x40, 0x1d, 0x60, 0xe4, 0xe2, 0xc5, 0xd9, // SBA(0) SF(保護) "USER"
  0x11, 0x40, 0x4a, 0x1d, 0x00, // SBA(10) SF(非保護)
  0x11, 0x40, 0x5a, 0x1d, 0x60, // SBA(26) SF(保護)
  0x11, 0x40, 0x4b, 0x13 // SBA(11) IC
]);

function setup(): { conn: WsConnection; sent: WsServerMessage[]; tn3270: Tn3270Manager } {
  const sent: WsServerMessage[] = [];
  const server = new ServerConfigStore({ systems: [], sessions: [] });
  const resolver = new ConfigResolver(server, new PersonalConfigStore());
  const tn3270 = new Tn3270Manager();
  const conn = new WsConnection(
    { sessions: new SessionManager(), resolver, tn3270 },
    { send: (d) => sent.push(JSON.parse(d) as WsServerMessage), close: () => {} }
  );
  return { conn, sent, tn3270 };
}

const waitFor = async (get: () => boolean, ms = 8000): Promise<boolean> => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (get()) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return false;
};

describe("WS から 3270 端末を開く", () => {
  let mini: Mini3270 | undefined;
  const start = async (port: number): Promise<number> => {
    mini = await startMini3270({ records: [SCREEN], port });
    return mini.port;
  };

  it("**open で画面が返る**——terminal を指定するだけ", async () => {
    const port = await start(3450);
    const { conn, sent, tn3270 } = setup();
    try {
      await conn.handle(JSON.stringify({ type: "open", terminal: "3270", host: "127.0.0.1", port }));
      expect(await waitFor(() => sent.some((m) => m.type === "opened"))).toBe(true);
      const opened = sent.find((m) => m.type === "opened") as Extract<WsServerMessage, { type: "opened" }>;
      expect(opened.sessionId).toBeTruthy();
      expect(opened.screen.rows).toBe(24);
      expect(opened.screen.cols).toBe(80);
      // 画面は screen イベントで後から届く（open 直後は交渉直後の空画面のこともある）
      expect(await waitFor(() => sent.some((m) => m.type === "screen"))).toBe(true);
      const screen = [...sent].reverse().find((m) => m.type === "screen") as Extract<
        WsServerMessage,
        { type: "screen" }
      >;
      const text = screen.screen.cells.map((r) => r.map((c) => c.char).join("")).join("\n");
      expect(text).toContain("USER");
      expect(screen.screen.fields.length).toBeGreaterThan(1);
      expect(screen.screen.fields.some((f) => !f.protected)).toBe(true);
    } finally {
      tn3270.closeAll();
      await mini?.close();
    }
  }, 30_000);

  it("**キーと入力欄がホストへ届く**", async () => {
    const port = await start(3451);
    const { conn, sent, tn3270 } = setup();
    try {
      await conn.handle(JSON.stringify({ type: "open", terminal: "3270", host: "127.0.0.1", port }));
      expect(await waitFor(() => sent.some((m) => m.type === "screen"))).toBe(true);
      const before = mini!.inbound().length;
      await conn.handle(
        JSON.stringify({
          type: "key",
          key: "Enter",
          fields: [{ field: { row: 1, col: 12 }, value: "AB" }]
        })
      );
      expect(sent.some((m) => m.type === "key-done"), "key-done が返らない").toBe(true);
      expect(await waitFor(() => mini!.inbound().length > before)).toBe(true);
      // AID(7d) ＋ カーソル ＋ SBA ＋ 打った内容（c1c2 = "AB"）
      const rec = mini!.inbound()[before] ?? "";
      expect(rec.startsWith("7d")).toBe(true);
      expect(rec).toContain("c1c2");
    } finally {
      tn3270.closeAll();
      await mini?.close();
    }
  }, 30_000);

  /**
   * **添字は 1 始まり**（`Field.index` の規約）。配列の添字として使うと 1 つずれる。
   * ブラウザ E2E で踏んだ——UI は欄を添字で指すので、TK4- の入力欄に打ったつもりが
   * **隣の保護欄に当たって `FIELD_PROTECTED`** になった。
   */
  it("**欄の添字は 1 始まりで解決する**（ブラウザが指す数え方）", async () => {
    const port = await start(3453);
    const { conn, sent, tn3270 } = setup();
    try {
      await conn.handle(JSON.stringify({ type: "open", terminal: "3270", host: "127.0.0.1", port }));
      expect(await waitFor(() => sent.some((m) => m.type === "screen"))).toBe(true);
      const screen = [...sent].reverse().find((m) => m.type === "screen") as Extract<
        WsServerMessage,
        { type: "screen" }
      >;
      const input = screen.screen.fields.find((f) => !f.protected)!;
      const before = mini!.inbound().length;
      // **index で指す**（座標ではなく）
      await conn.handle(
        JSON.stringify({ type: "key", key: "Enter", fields: [{ field: input.index, value: "XY" }] })
      );
      expect(sent.some((m) => m.type === "error"), "保護欄に当たっている").toBe(false);
      expect(await waitFor(() => mini!.inbound().length > before)).toBe(true);
      expect(mini!.inbound()[before] ?? "").toContain("e7e8"); // "XY"
    } finally {
      tn3270.closeAll();
      await mini?.close();
    }
  }, 30_000);

  it("**5250 専用の操作は 3270 セッションで断る**", async () => {
    const port = await start(3452);
    const { conn, sent, tn3270 } = setup();
    try {
      await conn.handle(JSON.stringify({ type: "open", terminal: "3270", host: "127.0.0.1", port }));
      expect(await waitFor(() => sent.some((m) => m.type === "screen"))).toBe(true);
      sent.length = 0;
      await conn.handle(JSON.stringify({ type: "gui-select", fieldId: "x", value: "y" }));
      expect(sent[0]).toMatchObject({ type: "error", code: "PROTOCOL_ERROR" });
      expect((sent[0] as { message: string }).message).toContain("3270");
    } finally {
      tn3270.closeAll();
      await mini?.close();
    }
  }, 30_000);

  it("**3270 が無効なサーバーでは断る**", async () => {
    const sent: WsServerMessage[] = [];
    const server = new ServerConfigStore({ systems: [], sessions: [] });
    const conn = new WsConnection(
      { sessions: new SessionManager(), resolver: new ConfigResolver(server, new PersonalConfigStore()) },
      { send: (d) => sent.push(JSON.parse(d) as WsServerMessage), close: () => {} }
    );
    await conn.handle(JSON.stringify({ type: "open", terminal: "3270", host: "127.0.0.1" }));
    expect(sent[0]).toMatchObject({ type: "error", code: "CONFIG_ERROR" });
  });
});

describe("3270 → Web の変換", () => {
  it("**使えないキーは読み替えずに拒否する**", () => {
    expect(toAid3270("Enter")).toBe("enter");
    expect(toAid3270("F13")).toBe("pf13");
    expect(toAid3270("PA2")).toBe("pa2");
    expect(toAid3270("Clear")).toBe("clear");
    // 5250 にしか無いキー——F7 に化けさせない
    for (const k of ["PageUp", "PageDown", "Help", "Print", "SysReq", "Attn", "F25"]) {
      expect(() => toAid3270(k), k).toThrow(/not available/);
    }
  });

  it("**モデル 3 / 4 は入口で断る**（web-ui の型に収まらない）", async () => {
    const mgr = new Tn3270Manager();
    await expect(
      mgr.open({ host: "127.0.0.1", port: 1, model: 3 as unknown as 2 })
    ).rejects.toThrow(/not supported/);
  });

  it("**画面は 5250 の型に写る**（web-ui は無改修）", async () => {
    const { Tn3270Session } = await import("@ts5250/tn3270");
    const { IAC, CMD, OPT, TT_SEND } = await import("../../tn3270/src/telnet/constants.js");
    let dataFn: ((d: Uint8Array) => void) | undefined;
    const s = new Tn3270Session({ host: "x", model: 2 });
    s.attach({
      send: () => undefined,
      close: () => undefined,
      onData: (fn) => (dataFn = fn),
      onClose: () => undefined,
      onError: () => undefined
    });
    const recv = (...b: number[]): void => dataFn?.(Uint8Array.from(b));
    recv(IAC, CMD.DO, OPT.TERMINAL_TYPE);
    recv(IAC, CMD.SB, OPT.TERMINAL_TYPE, TT_SEND, IAC, CMD.SE);
    recv(IAC, CMD.DO, OPT.END_OF_RECORD, IAC, CMD.WILL, OPT.END_OF_RECORD);
    recv(IAC, CMD.DO, OPT.BINARY, IAC, CMD.WILL, OPT.BINARY);
    recv(...SCREEN, IAC, CMD.EOR);

    const wire = toWireScreen(s, "sid-1");
    expect(wire.sessionId).toBe("sid-1");
    expect(wire.rows).toBe(24);
    expect(wire.cells[0]![0]!.columnSeparator).toBe(false); // 5250 側にしか無い項目は false 固定
    expect(wire.fields[0]!.mdt).toBe(false); // 3270 の modified は 5250 の mdt
    expect(wire.cells.flat().every((c) => c.color !== ("default" as unknown))).toBe(true);
  });
});
