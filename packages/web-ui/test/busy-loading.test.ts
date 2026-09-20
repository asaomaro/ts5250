import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { ScreenSnapshot } from "@ts5250/tn5250";

// WsClient をモック（connect 即時解決・send スパイ・handlers 捕捉）
let captured: { handlers: { onServerMessage: (m: unknown) => void }; send: ReturnType<typeof vi.fn> };
vi.mock("../src/ws-client.js", () => ({
  // `session-controller` が `wsUrl` も import するので、モックにも持たせる
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

describe("通信中プロテクト・0.5 秒ローディング", () => {
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
    captured.send.mockClear(); // open メッセージの送信をカウントから除く
  }

  it("送信で busy=true、0.5 秒未満はローディングなし、0.5 秒超でローディング表示", async () => {
    await open();
    sendKey("s1", "Enter");
    const s = sessionsStore.get("s1")!;
    expect(s.busy).toBe(true);
    expect(s.loading).toBe(false); // 送信直後はスピナー出さない
    expect(captured.send).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(499);
    expect(s.loading).toBe(false); // 0.5 秒未満
    vi.advanceTimersByTime(1);
    expect(s.loading).toBe(true); // 0.5 秒到達でローディング
  });

  it("応答（screen）で busy/loading が解除される", async () => {
    await open();
    sendKey("s1", "Enter");
    vi.advanceTimersByTime(500);
    expect(sessionsStore.get("s1")!.loading).toBe(true);

    captured.handlers.onServerMessage({ type: "screen", screen: snap() });
    const s = sessionsStore.get("s1")!;
    expect(s.busy).toBe(false);
    expect(s.loading).toBe(false);
  });

  it("0.5 秒未満で応答が来ればローディングは出ない", async () => {
    await open();
    sendKey("s1", "Enter");
    vi.advanceTimersByTime(200);
    captured.handlers.onServerMessage({ type: "screen", screen: snap() });
    vi.advanceTimersByTime(500); // タイマーは解除済み
    expect(sessionsStore.get("s1")!.loading).toBe(false);
  });

  it("施錠されたままの画面では待ちを解かず、0.5 秒でスピナーを出す", async () => {
    // 時間の掛かる CALL は、走り出す前にホストが画面を 1 枚書いてくることがある。
    // そこで待ちを解くと猶予タイマーごと潰れ、どれだけ待たされてもスピナーが出なかった
    await open();
    sendKey("s1", "Enter");
    vi.advanceTimersByTime(200);
    captured.handlers.onServerMessage({ type: "screen", screen: snap(true) });
    const s = sessionsStore.get("s1")!;
    expect(s.busy).toBe(true); // 施錠されたまま＝まだ応答ではない
    vi.advanceTimersByTime(300);
    expect(s.loading).toBe(true);

    captured.handlers.onServerMessage({ type: "screen", screen: snap() }); // 開いた画面で解ける
    expect(s.busy).toBe(false);
    expect(s.loading).toBe(false);
  });

  it("施錠中（busy でなくても）は送信をプロテクトする", async () => {
    // ホスト発の施錠（応答待ちの途中経過）では busy が立たない。
    // ここを通すと core の assertReady が KEYBOARD_LOCKED を投げるだけになる
    await open();
    captured.handlers.onServerMessage({ type: "screen", screen: snap(true) });
    expect(sessionsStore.get("s1")!.busy).toBeFalsy(); // 送っていないので busy は立たない
    sendKey("s1", "Enter");
    expect(captured.send).not.toHaveBeenCalled();
  });

  /**
   * **逃げ道は塞がない。** 画面は期限を設けずにホストを待つようになった
   * （`ws-handler.onKey` の `timeoutMs: "never"`）ので、Attn / SysReq が唯一の出口になる。
   * 5250 でも実機でも、この 2 つは応答待ちの最中にこそ使う。
   */
  it("応答待ちの最中でも Attn は通り、元の待ちは解けない", async () => {
    await open();
    sendKey("s1", "Enter");
    const s = sessionsStore.get("s1")!;
    expect(s.busy).toBe(true);
    captured.send.mockClear();

    sendKey("s1", "Attn");
    expect(captured.send).toHaveBeenCalledTimes(1); // プロテクトを素通りする
    expect(s.busy).toBe(true); // **busy には載せない**——元の待ちのスピナーを消さない
  });

  it("施錠中でも SysReq は通る", async () => {
    await open();
    captured.handlers.onServerMessage({ type: "screen", screen: snap(true) });
    captured.send.mockClear();
    sendKey("s1", "SysReq", undefined, "2");
    expect(captured.send).toHaveBeenCalledTimes(1);
  });

  /**
   * ~~フラグキーには欄を載せない（打ちかけの入力を無駄に流さない）~~
   * → **覆した**（`20260920-restore-screen-parity` decisions D6）。
   *
   * ACS は打鍵した文字を表示バッファに持ち、それが SAVE SCREEN の退避に入るので
   * Attn → F12 で戻っても消えない（同 research F1・F4・F11）。当 PJ は打鍵をブラウザだけが
   * 持っていたので、**退避の時点でサーバーが知らず、戻ると空になっていた**。
   *
   * **ホストへ送るバイト列は変わらない**——フラグレコードは欄データを載せない
   * （ACS の Attn も本体空のフラグレコード。同 research F17）。載せるのは
   * 「サーバーの画面バッファへ移すため」で、サーバーは**施錠中なら書かない**
   * （`packages/server/src/ws-handler.ts`。SysReq の逃げ道を守る）。
   */
  it("フラグキーにも欄を載せる（サーバー側の退避に打鍵を載せるため）", async () => {
    await open();
    const s = sessionsStore.get("s1")!;
    s.edits.set(0, "WRKACTJOB");
    captured.send.mockClear();

    sendKey("s1", "Attn");
    expect(captured.send.mock.calls[0]![0]).toHaveProperty("fields");
    // 通常キーも従来どおり載せる
    captured.send.mockClear();
    sendKey("s1", "Enter");
    expect(captured.send.mock.calls[0]![0]).toHaveProperty("fields");
  });

  /**
   * **待たされている間、こちらからは何も言わない**（ACS と同じ）。
   *
   * 旧実装は 30 秒で「応答がありませんでした」と嘘をついて施錠まで解いていた。それをやめた
   * 折に「事実だけを言う」通知を同じ 30 秒に置いたが、**ACS にも実機にもそんなメッセージは
   * 無い**うえ、ホストが出している進捗表示（`MSGTYPE(*STATUS)`）を押しのけるので消した。
   * 出るのはスピナーと OIA の 🔒 だけ。
   */
  it("何秒待たされても操作員メッセージは出さない（スピナーと施錠表示だけ）", async () => {
    await open();
    sendKey("s1", "Enter");
    const s = sessionsStore.get("s1")!;
    vi.advanceTimersByTime(30_000);
    expect(s.notice).toBeUndefined();
    vi.advanceTimersByTime(300_000); // 5 分待っても同じ
    expect(s.notice).toBeUndefined();
    expect(s.busy).toBe(true); // 待ちそのものは続いている
    expect(s.loading).toBe(true);
  });

  it("先に出ている通知を待ち時間で消したりしない", async () => {
    await open();
    sendKey("s1", "Enter");
    const s = sessionsStore.get("s1")!;
    s.notice = "PC コマンドを実行しています";
    vi.advanceTimersByTime(30_000);
    expect(s.notice).toBe("PC コマンドを実行しています");
  });

  it("通信中（busy）は多重送信をプロテクトする", async () => {
    await open();
    sendKey("s1", "Enter");
    expect(captured.send).toHaveBeenCalledTimes(1);
    sendKey("s1", "F3"); // busy 中は無視
    expect(captured.send).toHaveBeenCalledTimes(1);
  });
});
