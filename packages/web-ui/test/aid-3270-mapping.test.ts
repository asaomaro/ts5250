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
 * **3270 に無いキーの扱い。**
 *
 * 5250 の口には `PageUp` / `PageDown` / `Attn` / `SysReq` があるが、**3270 には無い**。
 * そのまま送るとサーバーが弾き、利用者には「押しても効かない」としか見えない
 * （実際にブラウザで踏んだ）。
 *
 * ページ送りは**実機で測って決めた**——IBM i を 3270 で操作すると `PF8` で次ページ・
 * `PF7` で前ページに動き、`PA1`/`PA2` では動かない。x3270 も同じ割り当てを同梱している。
 *
 * **読み替えは送信の一本道に置く**——キーボードも状態バーのボタンもここを通るので、
 * 片方だけ直すと「キーボードでは動くのにボタンでは動かない」になる。
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

describe("3270 で押せないキーの読み替え", () => {
  beforeEach(() => {
    sessionsStore.byId.clear();
    sessionsStore.order = [];
  });

  it("**PageDown は F8、PageUp は F7 として出る**（実機で測った割り当て）", async () => {
    await open("3270");
    sendKey("s1", "PageDown");
    expect(sentKey()).toBe("F8");
    sessionsStore.get("s1")!.busy = false;
    sendKey("s1", "PageUp");
    expect(sentKey()).toBe("F7");
  });

  it("**Attn / SysReq は送らずに案内を出す**（黙って捨てない）", async () => {
    await open("3270");
    sendKey("s1", "Attn");
    expect(captured.send).not.toHaveBeenCalled();
    expect(sessionsStore.get("s1")!.notice).toMatch(/3270/);
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
