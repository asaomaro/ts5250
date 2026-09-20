import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ScreenSnapshot } from "@ts5250/tn5250";

let captured: { handlers: { onServerMessage: (m: unknown) => void }; send: ReturnType<typeof vi.fn> };
vi.mock("../src/ws-client.js", () => ({
  wsUrl: () => "ws://test/ws",
  WsClient: class {
    send = vi.fn();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    constructor(_url: string, handlers: any) {
      captured = { handlers, send: this.send };
    }
    connect() {
      return Promise.resolve();
    }
    close() {}
    setHiddenIndexes() {}
    setSessionId() {}
  }
}));

import { openSession, sendKey } from "../src/session-controller.js";
import { sessionsStore } from "../src/stores/sessions.js";

/**
 * **フラグキー（Attn / SysReq）にも打鍵した欄を載せる。**
 *
 * ACS は打鍵した文字を表示バッファ（`PS5250` の `HostPlane` / `TextPlane`）に持ち、それが
 * SAVE SCREEN の退避に入るので、Attn → F12 で戻っても消えない
 * （`20260920-restore-screen-parity` research F1・F4・F11）。当 PJ は打鍵をブラウザだけが
 * 持っていたため、退避の時点でサーバーが知らず、戻ったときに空になっていた（decisions D6）。
 *
 * **ホストへ送るバイト列は変わらない**——フラグレコードは欄データを載せないので
 * （ACS の Attn も本体空。同 research F17）、載せるのは「サーバーの画面バッファへ移すため」。
 * サーバーは施錠中なら書かない（`packages/server/src/ws-handler.ts`）。
 */
const snap = (locked = false): ScreenSnapshot => ({
  sessionId: "s1", rows: 24, cols: 80, cursor: { row: 1, col: 1 },
  keyboardLocked: locked, cells: [], fields: []
});

async function open(): Promise<void> {
  sessionsStore.byId.clear();
  sessionsStore.order = [];
  const p = openSession({ type: "open", host: "h" }, "t", {});
  captured.handlers.onServerMessage({ type: "opened", sessionId: "s1", screen: snap() });
  await p;
  captured.send.mockClear();
}

const lastSent = (): { key?: string; fields?: { field: number; value: string }[] } | undefined =>
  captured.send.mock.calls.at(-1)?.[0] as { key?: string; fields?: { field: number; value: string }[] } | undefined;

describe("フラグキーにも打鍵した欄を載せる", () => {
  beforeEach(() => {
    sessionsStore.byId.clear();
    sessionsStore.order = [];
  });

  it("Attn に打ちかけの欄が載る（ACS と同じく退避へ回すため）", async () => {
    await open();
    sessionsStore.get("s1")!.edits.set(3, "WRKACTJOB");
    sendKey("s1", "Attn");
    expect(lastSent()?.key).toBe("Attn");
    expect(lastSent()?.fields).toEqual([{ field: 3, value: "WRKACTJOB" }]);
  });

  it("SysReq にも載る", async () => {
    await open();
    sessionsStore.get("s1")!.edits.set(1, "X");
    sendKey("s1", "SysReq");
    expect(lastSent()?.key).toBe("SysReq");
    expect(lastSent()?.fields).toEqual([{ field: 1, value: "X" }]);
  });

  it("打鍵が無ければ `fields` は付けない（空配列を送らない）", async () => {
    await open();
    sendKey("s1", "Attn");
    expect(lastSent()?.key).toBe("Attn");
    expect(lastSent()?.fields).toBeUndefined();
  });

  /**
   * **施錠中は載せない。** サーバーは施錠中に書かない（SysReq の逃げ道を未送信の入力で
   * 塞がないため）ので、送っても捨てられるだけ——打ちかけの値を無駄に流すことになる
   * （`20260920-restore-screen-parity` の cross 点検の指摘）。
   */
  it("施錠中のフラグキーには欄を載せない（送っても捨てられるだけ）", async () => {
    await open();
    captured.handlers.onServerMessage({ type: "screen", screen: snap(true) });
    sessionsStore.get("s1")!.edits.set(0, "SECRET");
    captured.send.mockClear();

    sendKey("s1", "SysReq", undefined, "2");
    expect(captured.send, "施錠中でも送信そのものは通る（逃げ道）").toHaveBeenCalledTimes(1);
    expect(lastSent()?.fields, "欄は載せない").toBeUndefined();
  });

  it("通常キーの扱いは変わらない", async () => {
    await open();
    sessionsStore.get("s1")!.edits.set(2, "AB");
    sendKey("s1", "Enter");
    expect(lastSent()?.fields).toEqual([{ field: 2, value: "AB" }]);
  });
});
