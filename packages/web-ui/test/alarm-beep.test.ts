/**
 * **ホストの警報（CC2 0x04）で短いビープを鳴らす**（ACS は `PS5250.ringBell()` で端末のベル）。
 *
 * 警報はサーバーから画面と別の `alarm` メッセージで届く（画面を変えないレコードでも来るため）。
 * ここで固定するのは:
 *
 *   - `alarm` を受けたら `beep()` を呼ぶこと（画面の更新には触らない）
 *   - `beep()` は Web Audio が無い・使えない環境でも**例外を投げない**こと
 *   - `AudioContext` は**鳴らすときに初めて作り、使い回す**こと
 *   - 送信前検査で自己点検欄に引っかかったら、`MSG_SELF_CHECK` を出して送らないこと
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { ScreenSnapshot } from "@ts5250/tn5250";

interface Fake {
  handlers: { onServerMessage: (m: unknown) => void };
  send: ReturnType<typeof vi.fn>;
}
let clients: Fake[] = [];

vi.mock("../src/ws-client.js", () => ({
  wsUrl: () => "ws://test/ws",
  WsClient: class {
    send = vi.fn();
    close = vi.fn();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    constructor(_url: string, handlers: any) {
      clients.push({ handlers, send: this.send });
    }
    connect() {
      return Promise.resolve();
    }
    setHiddenIndexes() {}
    setSessionId() {}
  }
}));

const beepSpy = vi.fn();
vi.mock("../src/beep.js", () => ({ beep: () => beepSpy() }));

import { openSession, sendKey, closeSession } from "../src/session-controller.js";
import { sessionsStore } from "../src/stores/sessions.js";
import { MSG_SELF_CHECK } from "../src/composables/opMessages.js";

function snap(fields: unknown[] = []): ScreenSnapshot {
  return {
    sessionId: "s1",
    rows: 24,
    cols: 80,
    cursor: { row: 5, col: 10 },
    keyboardLocked: false,
    cells: [],
    fields
  } as unknown as ScreenSnapshot;
}

async function open(screen = snap()) {
  const p = openSession({ type: "open", host: "h" }, "t");
  clients[0]!.handlers.onServerMessage({ type: "opened", sessionId: "s1", screen });
  await p;
  return sessionsStore.get("s1")!;
}

describe("session-controller: 警報と自己点検", () => {
  beforeEach(() => {
    clients = [];
    beepSpy.mockClear();
    sessionsStore.byId.clear();
    sessionsStore.order = [];
  });
  afterEach(() => {
    if (sessionsStore.get("s1")) closeSession("s1");
  });

  it("alarm を受けるたびにビープを鳴らし、画面には触らない", async () => {
    const s = await open();
    const before = s.snapshot;
    clients[0]!.handlers.onServerMessage({ type: "alarm" });
    clients[0]!.handlers.onServerMessage({ type: "alarm" });
    expect(beepSpy).toHaveBeenCalledTimes(2);
    expect(s.snapshot).toBe(before);
  });

  it("自己点検欄の検査桁が合わなければ、MSG_SELF_CHECK を出して送らない", async () => {
    const field = {
      index: 1, row: 5, col: 10, length: 4,
      protected: false, hidden: false, numeric: true, mdt: false, value: "",
      selfCheck: "mod10"
    };
    const s = await open(snap([field]));
    s.edits.set(1, "1234");
    const sentBefore = clients[0]!.send.mock.calls.length;
    const hit = sendKey("s1", "Enter");
    expect(hit?.reason).toBe("self-check");
    expect(s.notice).toBe(MSG_SELF_CHECK);
    expect(clients[0]!.send.mock.calls.length).toBe(sentBefore);

    // 正しい検査桁なら送る
    s.edits.set(1, "1230");
    expect(sendKey("s1", "Enter")).toBeUndefined();
    expect(clients[0]!.send.mock.calls.length).toBe(sentBefore + 1);
  });
});

describe("beep()", () => {
  const w = window as unknown as { AudioContext?: unknown; webkitAudioContext?: unknown };
  const saved = { AudioContext: w.AudioContext, webkitAudioContext: w.webkitAudioContext };

  afterEach(() => {
    w.AudioContext = saved.AudioContext;
    w.webkitAudioContext = saved.webkitAudioContext;
  });

  /** モジュールの `ctx`（使い回す文脈）をテストごとに作り直すため、毎回読み込み直す */
  async function freshBeep(): Promise<() => void> {
    vi.resetModules();
    vi.doUnmock("../src/beep.js");
    const mod = await vi.importActual<typeof import("../src/beep.js")>("../src/beep.js");
    return mod.beep;
  }

  function fakeAudioContext(state = "running") {
    const created: FakeCtx[] = [];
    class FakeCtx {
      state = state;
      currentTime = 1;
      destination = {};
      resume = vi.fn(() => Promise.resolve());
      oscillators: { start: ReturnType<typeof vi.fn>; stop: ReturnType<typeof vi.fn> }[] = [];
      constructor() {
        created.push(this);
      }
      createOscillator() {
        const gainNode = { connect: vi.fn((d: unknown) => d) };
        const osc = {
          type: "",
          frequency: { value: 0 },
          connect: vi.fn(() => gainNode),
          start: vi.fn(),
          stop: vi.fn()
        };
        this.oscillators.push(osc);
        return osc;
      }
      createGain() {
        return {
          gain: { setValueAtTime: vi.fn(), linearRampToValueAtTime: vi.fn() },
          connect: vi.fn((d: unknown) => d)
        };
      }
    }
    return { FakeCtx, created };
  }

  it("Web Audio が無い環境では何もせず、例外も投げない", async () => {
    w.AudioContext = undefined;
    w.webkitAudioContext = undefined;
    const beep = await freshBeep();
    expect(() => beep()).not.toThrow();
  });

  it("AudioContext の生成で失敗しても例外を投げない（音声を許可していない環境）", async () => {
    w.AudioContext = class {
      constructor() {
        throw new Error("not allowed");
      }
    };
    const beep = await freshBeep();
    expect(() => beep()).not.toThrow();
  });

  it("鳴らすときに初めて文脈を作り、2 回目以降は使い回す", async () => {
    const { FakeCtx, created } = fakeAudioContext();
    w.AudioContext = FakeCtx;
    const beep = await freshBeep();
    expect(created).toHaveLength(0); // 読み込んだだけでは作らない
    beep();
    beep();
    expect(created).toHaveLength(1);
    expect(created[0]!.oscillators).toHaveLength(2);
    expect(created[0]!.oscillators[0]!.start).toHaveBeenCalledWith(1);
    expect(created[0]!.oscillators[0]!.stop).toHaveBeenCalledWith(1.13);
  });

  it("自動再生の制限で止まっている文脈は再開してから鳴らす", async () => {
    const { FakeCtx, created } = fakeAudioContext("suspended");
    w.AudioContext = FakeCtx;
    const beep = await freshBeep();
    beep();
    expect(created[0]!.resume).toHaveBeenCalled();
  });

  it("webkit 接頭辞の実装でも鳴らす", async () => {
    const { FakeCtx, created } = fakeAudioContext();
    w.AudioContext = undefined;
    w.webkitAudioContext = FakeCtx;
    const beep = await freshBeep();
    beep();
    expect(created).toHaveLength(1);
  });
});
