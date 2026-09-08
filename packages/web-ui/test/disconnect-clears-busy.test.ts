/**
 * **接続が死んだら応答待ちを解く**（実機報告: ローディングが解除されない）。
 *
 * 実機で「ローディングで待たされた後、そのまま解除されない。操作ログの最後は closed」
 * という事象が出た。ホスト側が閉じたときはサーバーが `closed` を送ってくるので待ちは
 * 解けるが、**ブラウザ ↔ サーバーの WebSocket が閉じただけのときは何も届かない**
 * （サーバー再起動・回線断・プロキシのアイドル切断）。当時 `WsClient` の `close` は
 * 操作ログに 1 行書くだけで、`session-controller` へは伝えていなかった。
 *
 * 結果、`busy` / `loading` が立ったまま残り、
 *
 *   - 応答待ちの覆いとスピナーが永久に消えない
 *   - 覆いが Attn / SysReq の逃げ道まで塞ぐ（#390 で開けた口が効かない）。しかも
 *     送れたところで `WsClient.send` は OPEN でなければ捨てるので届かない
 *   - 状態表示は「接続中」のまま——切れたことがどこにも出ない
 *
 * となり、タブを開き直す以外に手が無かった。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { ScreenSnapshot } from "@ts5250/tn5250";
import { MSG_NOT_CONNECTED } from "../src/composables/opMessages.js";

// WsClient をモック（connect 即時解決・send スパイ・handlers 捕捉）
let captured: {
  handlers: { onServerMessage: (m: unknown) => void; onClose?: () => void };
  send: ReturnType<typeof vi.fn>;
};
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

function snap(keyboardLocked = false): ScreenSnapshot {
  return {
    sessionId: "s1",
    rows: 24,
    cols: 80,
    cursor: { row: 1, col: 1 },
    keyboardLocked,
    cells: [],
    fields: []
  };
}

describe("接続断で応答待ちを解く", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    sessionsStore.byId.clear();
    sessionsStore.order = [];
  });
  afterEach(() => vi.useRealTimers());

  async function open() {
    const p = openSession({ type: "open", host: "h" }, "t");
    captured.handlers.onServerMessage({ type: "opened", sessionId: "s1", screen: snap() });
    await p;
    captured.send.mockClear();
  }

  it("応答待ちの最中に WebSocket が閉じたら busy/loading が解ける", async () => {
    await open();
    sendKey("s1", "Enter");
    vi.advanceTimersByTime(500);
    const s = sessionsStore.get("s1")!;
    expect(s.loading).toBe(true); // 覆いとスピナーが出ている

    captured.handlers.onClose?.();

    expect(s.busy).toBe(false);
    expect(s.loading).toBe(false);
    expect(s.connected).toBe(false);
  });

  /**
   * **切れたことを黙って飲み込まない。**
   *
   * 応急修正の時点では操作員メッセージ（「開き直してください」）を出していたが、
   * 繋ぎ直しが入った今は**その場で再接続を始める**ので、伝え方が変わった
   * （`20260908-session-survives-disconnect`）。見えるのは「再接続中 (1/5)」で、
   * 諦めたときに初めて理由が出る。
   */
  it("切れたら繋ぎ直しに入り、そのことが状態から分かる", async () => {
    await open();
    sendKey("s1", "Enter");

    captured.handlers.onClose?.();

    const s = sessionsStore.get("s1")!;
    expect(s.connected).toBe(false);
    expect(s.reconnect).toEqual({ attempt: 1, max: 5 });
  });

  it("繋がっていないあいだの送信は、黙って捨てずに理由を出す", async () => {
    await open();
    captured.handlers.onClose?.();
    captured.send.mockClear();

    sendKey("s1", "Enter");

    expect(captured.send).not.toHaveBeenCalled();
    expect(sessionsStore.get("s1")!.notice).toBe(MSG_NOT_CONNECTED);
  });

  it("解いた後にローディングのタイマーが後から立たない", async () => {
    await open();
    sendKey("s1", "Enter");
    captured.handlers.onClose?.(); // 0.5 秒の猶予タイマーごと畳む

    // **700ms 止まりにする。** 繋ぎ直しの 1 回目は 800〜1200ms（±20% のゆらぎ）に散るので、
    // 1000ms 進めると**実行のたびに再接続が走ったり走らなかったり**して、
    // このテストが何を通しているか変わる。ローディングの猶予は 500ms なので 700ms で足りる
    vi.advanceTimersByTime(700);

    expect(sessionsStore.get("s1")!.loading).toBe(false);
  });
});
