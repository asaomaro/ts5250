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
    /** **自分の promise を持つ**（最後に作られたものを返すと、2 本作ってから繋ぐ形で崩れる） */
    private readonly connectResult: Promise<void>;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    constructor(_url: string, handlers: any) {
      this.connectResult = connectFails ? Promise.reject(new Error("nope")) : Promise.resolve();
      this.connectResult.catch(() => undefined); // 未処理の rejection にしない
      clients.push({ handlers, send: this.send, close: this.close, connectResult: this.connectResult });
    }
    connect() {
      return this.connectResult;
    }
    setHiddenIndexes() {}
    setSessionId() {}
  }
}));

import { openSession, sendKey, retryReconnect, closeSession } from "../src/session-controller.js";
import { sessionsStore } from "../src/stores/sessions.js";
import { MSG_NOT_CONNECTED, MSG_SESSION_ENDED } from "../src/composables/opMessages.js";

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
    // **モジュール側の待ち・飛行中の口を畳んでから次のテストへ。**
    // `sessionsStore` を消すだけでは `reconnectTimers` / `pendingResumes` が残り、
    // 次のテスト（同じ id `"s1"` を使う）が前のモックに `close()` を打つ
    if (sessionsStore.get("s1")) closeSession("s1");
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

    // **もう入り直さない**——押しても同じ理由で失敗するはしごを回さない。
    // 待ちが畳まれただけではなく、**再入の口（元の接続の遅れた `close`）を叩いても
    // 入らない**ことまで見る
    const before = clients.length;
    clients[0]!.handlers.onClose?.();
    await runAttempt(60_000);
    expect(s.reconnect).toBeUndefined();
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

  /**
   * **消える向きも見る。** 留守中に予約が解除されていたのに取り込まないと、
   * 覆いが残ったまま打てなくなる（次の `reserved` push まで復帰できない）。
   */
  it("留守中に予約が解除されていたら、繋ぎ直しで覆いも外れる", async () => {
    const s = await open();
    sessionsStore.setReserved("s1", "macro");
    expect(s.reservedBy).toBe("macro");
    clients[0]!.handlers.onClose?.();
    await runAttempt(1_000);

    clients[1]!.handlers.onServerMessage({
      type: "opened",
      sessionId: "s1",
      screen: snap(),
      pcCommand: false
      // reservedBy 無し＝もう予約されていない
    });

    expect(s.reservedBy).toBeUndefined();
  });

  /**
   * **3270 は繋ぎ直しの対象外**（`decisions.md` D3）。
   *
   * 3270 は 5250 と同じ `openSession` で開かれるので `kind` が付かない。素通しすると
   * `resume` がサーバーの 5250 専用 `attach` に流れて必ず失敗し、「再接続中」を見せた末に
   * 生のエラー文が出る。**それでも応答待ちは解けていなければならない**。
   */
  it("3270 は繋ぎ直さないが、待ちは解けて切断になる", async () => {
    const p = openSession({ type: "open", host: "h" }, "t", { terminal: "3270" });
    clients[0]!.handlers.onServerMessage({ type: "opened", sessionId: "s1", screen: snap() });
    await p;
    const s = sessionsStore.get("s1")!;
    sendKey("s1", "Enter");
    expect(s.busy).toBe(true);

    clients[0]!.handlers.onClose?.();

    expect(s.busy).toBe(false);
    expect(s.connected).toBe(false);
    expect(s.reconnect).toBeUndefined();
    await runAttempt(60_000);
    expect(clients).toHaveLength(1); // 試行を 1 回も出していない
  });

  it("繋がっていないあいだは送らず、**転送断だと言う**", async () => {
    const s = await open();
    clients[0]!.handlers.onClose?.();
    clients[0]!.send.mockClear();

    sendKey("s1", "Enter");

    expect(clients[0]!.send).not.toHaveBeenCalled();
    expect(s.notice).toBe(MSG_NOT_CONNECTED);
  });

  /**
   * **理由を取り違えない。** `connected` は転送が落ちたときにも、ホスト側のセッションが
   * 終わったとき（サーバー発 `closed`）にも落ちる。後者では転送は生きているので
   * 「サーバーと繋がっていない」は嘘になる。
   */
  it("ホスト側が終わっている場合は、転送断とは別の理由を言う", async () => {
    const s = await open();
    clients[0]!.handlers.onServerMessage({ type: "closed", reason: "host closed" });
    expect(s.connected).toBe(false);
    expect(s.reconnect).toBeUndefined(); // 繋ぎ直しには入っていない

    sendKey("s1", "Enter");

    expect(s.notice).toBe(MSG_SESSION_ENDED);
  });

  /**
   * **走っている最中の切断通知でやり直さない。**
   *
   * 古い口の `close` イベントは、既に次の試行が飛んだあとに遅れて届くことがある。
   * そこで入り直すと、**飛行中の試行を畳んではしごを頭から回す**——繋がりかけていた
   * ものを自分で切ることになる。
   */
  it("**二重に走らせない**（遅れて来た切断通知が、飛行中の試行を畳まない）", async () => {
    const s = await open();
    clients[0]!.handlers.onClose?.();
    await runAttempt(1_000);
    expect(clients).toHaveLength(2);

    clients[0]!.handlers.onClose?.(); // 古い口の通知が遅れて届いた

    expect(clients[1]!.close).not.toHaveBeenCalled();
    expect(s.reconnect).toEqual({ attempt: 1, max: 5 });
  });

  it("**そもそも開けない場合も次の間隔へ回す**（サーバー再起動中の典型）", async () => {
    const s = await open();
    connectFails = true;
    clients[0]!.handlers.onClose?.();

    await runAttempt(1_000);

    expect(s.reconnect).toEqual({ attempt: 2, max: 5 });
  });

  it("繋ぎ直しの `opened` から PC コマンドの履歴とジョブも取り込む", async () => {
    const s = await open();
    clients[0]!.handlers.onClose?.();
    await runAttempt(1_000);

    clients[1]!.handlers.onServerMessage({
      type: "opened",
      sessionId: "s1",
      screen: snap(),
      pcCommand: true,
      pcCommands: [{ at: 1, command: "WRKACTJOB", wait: false, hostname: "pc" }],
      job: { name: "WEBEMU01", user: "TANAKA" }
    });

    expect(s.pcCommandEnabled).toBe(true);
    expect(s.pcCommands).toHaveLength(1);
    expect(s.job?.name).toBe("WEBEMU01");
  });

  it("**利用者が閉じたら、飛行中の繋ぎ直しも畳む**（持ち主不在のセッションを残さない）", async () => {
    await open();
    clients[0]!.handlers.onClose?.();
    await runAttempt(1_000);
    const inflight = clients[1]!;

    closeSession("s1");

    expect(inflight.close).toHaveBeenCalled();
  });

  it("閉じたあとに `opened` が返っても、そのセッションを引き取らせない", async () => {
    await open();
    clients[0]!.handlers.onClose?.();
    await runAttempt(1_000);
    const inflight = clients[1]!;
    sessionsStore.remove("s1"); // タブが先に消えた（`closeSession` の後半だけを再現）

    inflight.handlers.onServerMessage({ type: "opened", sessionId: "s1", screen: snap(), pcCommand: false });

    // サーバー側は `cancelHold` + `claim` を済ませているので、こちらから畳まないと残る
    expect(inflight.send).toHaveBeenCalledWith({ type: "close" });
    expect(inflight.close).toHaveBeenCalled();
  });
});
