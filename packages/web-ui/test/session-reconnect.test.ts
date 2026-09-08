/**
 * 転送が落ちたときの繋ぎ直し（`20260908-session-survives-disconnect`）。
 *
 * 実機で「応答待ちのローディングが解除されない／開き直すと前回セッションが閉じられた警告が出る」
 * という報告が出た。サーバーは転送断でセッションをすぐ閉じず猶予として保持するようになったので、
 * クライアントは**同じセッションへ繋ぎ直せる**。ここで固定するのは:
 *
 *   - 切れたら自動で繋ぎ直しに入り、`resume: true` を送ること
 *   - 成功したら**口だけ差し替え、打ちかけの入力（`edits`）は残す**こと
 *   - 「そのセッションはもう無い」と言われたら**再試行せず、押しても無駄なボタンも出さない**こと
 *   - 転送が繋がらないまま尽きたときだけ**手動の繋ぎ直しを出す**こと
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { ScreenSnapshot } from "@ts5250/tn5250";
import { MSG_RECONNECT_GAVE_UP } from "../src/composables/opMessages.js";

/** 生成された WsClient を順に捕まえる（1 本目＝最初の接続、2 本目以降＝繋ぎ直し） */
interface Fake {
  handlers: { onServerMessage: (m: unknown) => void; onClose?: () => void };
  send: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
  connectResult: Promise<void>;
}
let clients: Fake[] = [];
let connectFails = false;

vi.mock("../src/ws-client.js", () => ({
  wsUrl: () => "ws://test/ws",
  WsClient: class {
    send = vi.fn();
    close = vi.fn();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    constructor(_url: string, handlers: any) {
      const connectResult = connectFails ? Promise.reject(new Error("nope")) : Promise.resolve();
      connectResult.catch(() => undefined); // 未処理の rejection にしない
      clients.push({ handlers, send: this.send, close: this.close, connectResult });
    }
    connect() {
      return clients[clients.length - 1]!.connectResult;
    }
    setHiddenIndexes() {}
    setSessionId() {}
  }
}));

import { openSession, sendKey, retryReconnect } from "../src/session-controller.js";
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
  } as unknown as ScreenSnapshot;
}

/** ゆらぎ（±20%）を消して、待ち時間を表どおりに進められるようにする */
const noJitter = (): void => {
  vi.spyOn(Math, "random").mockReturnValue(0.5);
};

/** 繋ぎ直しの待ちを 1 段ぶん進めて、その試行を走らせる */
async function runAttempt(ms: number): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms);
}

describe("転送断からの繋ぎ直し", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    noJitter();
    clients = [];
    connectFails = false;
    sessionsStore.byId.clear();
    sessionsStore.order = [];
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  async function open() {
    const p = openSession({ type: "open", host: "h" }, "t");
    clients[0]!.handlers.onServerMessage({ type: "opened", sessionId: "s1", screen: snap() });
    await p;
    return sessionsStore.get("s1")!;
  }

  it("切れたら繋ぎ直しに入り、`resume: true` を送る", async () => {
    const s = await open();
    clients[0]!.handlers.onClose?.();
    expect(s.reconnect).toEqual({ attempt: 1, max: 5 });

    await runAttempt(1_000);

    expect(clients).toHaveLength(2);
    expect(clients[1]!.send).toHaveBeenCalledWith({ type: "open", sessionId: "s1", resume: true });
  });

  it("**成功したら口だけ差し替え、セッションはそのまま続く**", async () => {
    const s = await open();
    const first = s.client;
    clients[0]!.handlers.onClose?.();
    await runAttempt(1_000);

    clients[1]!.handlers.onServerMessage({
      type: "opened",
      sessionId: "s1",
      screen: snap(),
      pcCommand: false
    });

    expect(s.connected).toBe(true);
    expect(s.reconnect).toBeUndefined();
    expect(s.client).not.toBe(first);
    expect(sessionsStore.get("s1")).toBe(s); // 作り直していない（同じセッションの続き）
  });

  /**
   * **打ちかけの入力は繋ぎ直しで捨てる**（`decisions.md` D11）。
   *
   * 設計の当初は「口だけ差し替えるので `edits` は残る」としていたが、繋ぎ直しで返るのは
   * **留守中にホストが書いた「いまの画面」**で、こちらが打っていた画面とは限らない。
   * 別の画面の欄へ打鍵を載せると、業務システムに**違う値を送ってしまう**。
   * 残すより捨てるほうが安全側なので、既存の `updateScreen` の規則（新画面で差分を捨てる）に
   * そのまま乗せている。
   */
  it("打ちかけの入力は捨てる（別の画面へ載せない）", async () => {
    const s = await open();
    s.edits.set(3, "ABC");
    clients[0]!.handlers.onClose?.();
    await runAttempt(1_000);

    clients[1]!.handlers.onServerMessage({
      type: "opened",
      sessionId: "s1",
      screen: snap(),
      pcCommand: false
    });

    expect(s.edits.size).toBe(0);
  });

  it("失敗したら間隔を空けて次を試す（1s → 2s → 4s …）", async () => {
    const s = await open();
    clients[0]!.handlers.onClose?.();

    await runAttempt(1_000);
    clients[1]!.handlers.onClose?.(); // 1 回目が繋がらなかった
    expect(s.reconnect).toEqual({ attempt: 2, max: 5 });

    await runAttempt(2_000);
    expect(clients).toHaveLength(3);
  });

  it("**試行が尽きたら手動の繋ぎ直しを出す**（転送はいずれ戻りうる）", async () => {
    const s = await open();
    clients[0]!.handlers.onClose?.();
    for (const ms of [1_000, 2_000, 4_000, 8_000, 16_000]) {
      await runAttempt(ms);
      clients[clients.length - 1]!.handlers.onClose?.();
    }

    expect(s.reconnect).toBeUndefined();
    expect(s.reconnectFailed).toBe("retry");
    expect(s.notice).toBe(MSG_RECONNECT_GAVE_UP);
  });

  it("手動の繋ぎ直しは、はしごを最初から回し直す", async () => {
    const s = await open();
    clients[0]!.handlers.onClose?.();
    for (const ms of [1_000, 2_000, 4_000, 8_000, 16_000]) {
      await runAttempt(ms);
      clients[clients.length - 1]!.handlers.onClose?.();
    }
    expect(s.reconnectFailed).toBe("retry");

    retryReconnect("s1");

    expect(s.reconnect).toEqual({ attempt: 1, max: 5 });
    expect(s.reconnectFailed).toBeUndefined();
  });

  it("**押し直しを 2 回続けても止まらない**（連打・キーリピートで固まらない）", async () => {
    const s = await open();
    clients[0]!.handlers.onClose?.();
    for (const ms of [1_000, 2_000, 4_000, 8_000, 16_000]) {
      await runAttempt(ms);
      clients[clients.length - 1]!.handlers.onClose?.();
    }
    const before = clients.length;

    retryReconnect("s1");
    retryReconnect("s1");
    await runAttempt(1_000);

    expect(s.reconnect).toEqual({ attempt: 1, max: 5 });
    expect(clients.length).toBeGreaterThan(before); // 実際に試行が走っている
  });

  it("**「そのセッションはもう無い」なら再試行せず、ボタンも出さない**", async () => {
    const s = await open();
    clients[0]!.handlers.onClose?.();
    await runAttempt(1_000);

    clients[1]!.handlers.onServerMessage({
      type: "error",
      code: "SESSION_NOT_FOUND",
      message: "session s1 not found"
    });

    expect(s.reconnect).toBeUndefined();
    expect(s.reconnectFailed).toBe("gone"); // 手動ボタンは出さない側
    expect(s.connected).toBe(false);
    expect(clients[1]!.close).toHaveBeenCalled();

    // **もう入り直さない**——押しても同じ理由で失敗するはしごを回さない
    const before = clients.length;
    await runAttempt(60_000);
    expect(clients).toHaveLength(before);
  });

  it("黙り込んだ試行は 10 秒で捨てる（誰も見ていない窓を作らない）", async () => {
    await open();
    clients[0]!.handlers.onClose?.();
    await runAttempt(1_000);
    expect(clients).toHaveLength(2);

    await runAttempt(10_000); // 応答が無いまま上限

    expect(clients[1]!.close).toHaveBeenCalled();
  });

  it("繋ぎ直しの `opened` から予約状態も取り込む（覆いが実態とずれない）", async () => {
    const s = await open();
    clients[0]!.handlers.onClose?.();
    await runAttempt(1_000);

    clients[1]!.handlers.onServerMessage({
      type: "opened",
      sessionId: "s1",
      screen: snap(),
      pcCommand: false,
      reservedBy: "macro"
    });

    expect(s.reservedBy).toBe("macro");
  });

  it("繋がっていないあいだは送らない（黙って捨てない）", async () => {
    const s = await open();
    clients[0]!.handlers.onClose?.();
    clients[0]!.send.mockClear();

    sendKey("s1", "Enter");

    expect(clients[0]!.send).not.toHaveBeenCalled();
    expect(s.notice).toBeTruthy();
  });
});
