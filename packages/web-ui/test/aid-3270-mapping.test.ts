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
 * **画面はキーを読み替えない。**
 *
 * 3270 の割り当ては**ホストの種類で変わる**——IBM i では `PF3` は F3 ではなく
 * 「画面の消去」で、F1〜F12 は `PA1` ＋ `PFn`。メインフレームは `PFn` がそのまま Fn。
 * どちらかを知っているのは**サーバーだけ**なので、表を画面にも置くと必ずずれる。
 *
 * 以前はここで `PageUp` を `F7` に写していたが、F キーの送り方が変わると
 * **ページ送りが F7 になって壊れる**。読み替えごとサーバーへ移した
 * （`server/src/tn3270-adapt.ts` の `planKey3270`）。
 */
const snap = (): ScreenSnapshot => ({
  sessionId: "s1", rows: 24, cols: 80, cursor: { row: 1, col: 1 },
  keyboardLocked: false, cells: [], fields: []
});

async function open(terminal?: "5250" | "3270"): Promise<void> {
  sessionsStore.byId.clear();
  sessionsStore.order = [];
  const p = openSession({ type: "open", host: "h" }, "t", terminal ? { terminal } : {});
  captured.handlers.onServerMessage({ type: "opened", sessionId: "s1", screen: snap() });
  await p;
  captured.send.mockClear();
}
const sentKey = (): string | undefined =>
  (captured.send.mock.calls.at(-1)?.[0] as { key?: string } | undefined)?.key;

describe("3270 でもキーはそのまま送る", () => {
  beforeEach(() => {
    sessionsStore.byId.clear();
    sessionsStore.order = [];
  });

  it("**ページ送りは読み替えない**（サーバーが素の PF7 / PF8 に落とす）", async () => {
    await open("3270");
    sendKey("s1", "PageDown");
    expect(sentKey()).toBe("PageDown");
    sessionsStore.get("s1")!.busy = false;
    sendKey("s1", "PageUp");
    expect(sentKey()).toBe("PageUp");
  });

  it("**Attn / SysReq も送る**（IBM i では使える。断るならサーバーが理由を返す）", async () => {
    await open("3270");
    sendKey("s1", "Attn");
    expect(sentKey()).toBe("Attn");
    sessionsStore.get("s1")!.busy = false;
    sendKey("s1", "SysReq");
    expect(sentKey()).toBe("SysReq");
  });

  it("**F キーと Enter はそのまま**", async () => {
    await open("3270");
    sendKey("s1", "F3");
    expect(sentKey()).toBe("F3");
    sessionsStore.get("s1")!.busy = false;
    sendKey("s1", "Enter");
    expect(sentKey()).toBe("Enter");
  });

  it("**5250 では読み替えない**——PageDown は PageDown のまま", async () => {
    await open();
    sendKey("s1", "PageDown");
    expect(sentKey()).toBe("PageDown");
  });
});
