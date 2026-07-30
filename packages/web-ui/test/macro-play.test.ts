import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Field, ScreenSnapshot } from "@as400web/core";
import type { PublicMacro, PublicMacroStep } from "@as400web/server";

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

import { openSession, sendKey, submitGuiSelection, selectGuiChoice } from "../src/session-controller.js";
import { sessionsStore } from "../src/stores/sessions.js";
import { macrosStore } from "../src/stores/macros.js";
import { play, pausePlay, resumePlay, stopPlay, screenMatches } from "../src/macro-engine.js";
import { macroStateOf } from "../src/macro-record.js";

/**
 * 再生の要点（spec D3・D4・D5・D11）:
 *   - `busy` が解けるまで待ってから次を送る（待たないと `sendKey` が黙って弾く）
 *   - 打ち込む先が記録時と同じ形で在るかを照合してから送る
 *   - 秘密は値ではなく `secretRef` を送る＝**平文はブラウザから出ない**
 */

function field(over: Partial<Field> & { index: number }): Field {
  return {
    row: 1, col: 1, length: 10, protected: false, hidden: false,
    numeric: false, mdt: false, value: "", ...over
  };
}

const SIGNON_FIELDS = [
  field({ index: 1, row: 5, col: 25, length: 10 }),
  field({ index: 2, row: 6, col: 25, length: 128, hidden: true })
];

function snap(fields: Field[] = SIGNON_FIELDS): ScreenSnapshot {
  return {
    sessionId: "s1", rows: 24, cols: 80, cursor: { row: 5, col: 25 },
    keyboardLocked: false, cells: [], fields
  };
}

function step(over: Partial<PublicMacroStep> = {}): PublicMacroStep {
  return {
    screen: { rows: 24, cols: 80, targets: [{ field: 1, row: 5, col: 25, len: 10 }] },
    fields: [{ field: 1, value: "USER" }],
    key: "Enter",
    cursor: { row: 5, col: 25 },
    ...over
  };
}

function macro(steps: PublicMacroStep[], over: Partial<PublicMacro> = {}): PublicMacro {
  return { id: "m-1", name: "サインオン", createdAt: 0, updatedAt: 0, hasSecret: false, steps, ...over };
}

async function open(opts: { readOnly?: boolean } = {}): Promise<void> {
  sessionsStore.byId.clear();
  sessionsStore.order = [];
  const p = openSession({ type: "open", host: "h", ...opts }, "t");
  captured.handlers.onServerMessage({ type: "opened", sessionId: "s1", screen: snap() });
  await p;
  captured.send.mockClear();
}

/** ホスト応答（busy 解除）。再生ループが次のステップへ進める */
function hostScreen(fields: Field[] = SIGNON_FIELDS): void {
  captured.handlers.onServerMessage({ type: "screen", screen: snap(fields) });
}

/** 再生ループのポーリング（25ms 間隔）を実時間で進める */
const tick = (ms = 80): Promise<void> => new Promise((r) => setTimeout(r, ms));

beforeEach(() => {
  macrosStore.macros = [];
  macrosStore.canStoreSecrets = true;
});

describe("screenMatches: 打ち込み先の照合（D4）", () => {
  it("同じ座標・長さ・入力可能なら一致", () => {
    expect(screenMatches(snap(), step())).toBe(true);
  });

  it("画面サイズが違えば不一致", () => {
    expect(screenMatches({ ...snap(), rows: 27, cols: 132 }, step())).toBe(false);
  });

  it("欄が消えていれば不一致", () => {
    expect(screenMatches(snap([]), step())).toBe(false);
  });

  it("欄が動いていれば不一致", () => {
    expect(screenMatches(snap([field({ index: 1, row: 9, col: 25, length: 10 })]), step())).toBe(false);
  });

  it("長さが変わっていれば不一致", () => {
    expect(screenMatches(snap([field({ index: 1, row: 5, col: 25, length: 4 })]), step())).toBe(false);
  });

  it("保護欄になっていれば不一致（打ち込めない先へ送らない）", () => {
    expect(
      screenMatches(snap([field({ index: 1, row: 5, col: 25, length: 10, protected: true })]), step())
    ).toBe(false);
  });
});

describe("マクロ再生: 進行と同期（D3）", () => {
  it("1 ステップ送り、応答を待ってから次を送る", async () => {
    await open();
    macrosStore.macros = [macro([step(), step({ key: "F4" })])];

    play("s1", "m-1");
    await tick();

    // 1 本目だけ送られ、busy で止まっている
    expect(captured.send).toHaveBeenCalledTimes(1);
    expect(captured.send.mock.calls[0]![0]).toMatchObject({ type: "key", key: "Enter" });
    expect(sessionsStore.get("s1")!.busy).toBe(true);

    hostScreen(); // 応答が来た
    await tick();

    expect(captured.send).toHaveBeenCalledTimes(2);
    expect(captured.send.mock.calls[1]![0]).toMatchObject({ key: "F4" });
  });

  it("全ステップを流し終えると completed で終わる", async () => {
    await open();
    macrosStore.macros = [macro([step()])];

    play("s1", "m-1");
    await tick();
    hostScreen();
    await tick();

    const rt = macroStateOf("s1")!;
    expect(rt.mode).toBe("idle");
    expect(rt.stopReason).toBe("completed");
  });

  it("記録した値とカーソルをそのまま送る", async () => {
    await open();
    macrosStore.macros = [macro([step({ fields: [{ field: 1, value: "WRKACTJOB" }] })])];

    play("s1", "m-1");
    await tick();

    expect(captured.send.mock.calls[0]![0]).toEqual({
      type: "key",
      key: "Enter",
      cursor: { row: 5, col: 25 },
      fields: [{ field: 1, value: "WRKACTJOB" }]
    });
  });

  it("SysReq はシステム要求行の文字列も送る", async () => {
    await open();
    macrosStore.macros = [
      macro([step({ key: "SysReq", sysReqText: "2", fields: [], screen: { rows: 24, cols: 80, targets: [] } })])
    ];

    play("s1", "m-1");
    await tick();

    expect(captured.send.mock.calls[0]![0]).toMatchObject({ key: "SysReq", sysReqText: "2" });
  });
});

describe("マクロ再生: 秘密の差し込み（D11）", () => {
  it("秘密欄は値ではなく secretRef を送る（平文がブラウザから出ない）", async () => {
    await open();
    macrosStore.macros = [
      macro(
        [
          step({
            screen: {
              rows: 24,
              cols: 80,
              targets: [
                { field: 1, row: 5, col: 25, len: 10 },
                { field: 2, row: 6, col: 25, len: 128 }
              ]
            },
            fields: [{ field: 1, value: "USER" }],
            secretFields: [2]
          })
        ],
        { hasSecret: true }
      )
    ];

    play("s1", "m-1");
    await tick();

    const sent = captured.send.mock.calls[0]![0] as { fields: unknown[] };
    expect(sent.fields).toEqual([
      { field: 1, value: "USER" },
      { field: 2, secretRef: { macroId: "m-1", step: 0, field: 2 } }
    ]);
    // 送信本文のどこにも値らしきものが無いこと
    expect(JSON.stringify(sent)).not.toContain("value\":\"dummy");
  });

  it("promptFields のステップでは送らずに自動休止する（D5）", async () => {
    await open();
    macrosStore.macros = [
      macro([
        step({
          screen: { rows: 24, cols: 80, targets: [{ field: 2, row: 6, col: 25, len: 128 }] },
          fields: [],
          promptFields: [2]
        })
      ])
    ];

    play("s1", "m-1");
    await tick();

    expect(captured.send).not.toHaveBeenCalled();
    const rt = macroStateOf("s1")!;
    expect(rt.mode).toBe("playPaused");
    expect(rt.message).toContain("入力してから再開");
  });
});

describe("マクロ再生: 休止・停止", () => {
  it("休止すると次を送らず、再開すると続きから流れる", async () => {
    await open();
    macrosStore.macros = [macro([step(), step({ key: "F4" })])];

    play("s1", "m-1");
    await tick();
    expect(captured.send).toHaveBeenCalledTimes(1);

    pausePlay("s1");
    hostScreen();
    await tick();
    expect(captured.send).toHaveBeenCalledTimes(1); // 休止中は進まない
    expect(macroStateOf("s1")!.mode).toBe("playPaused");

    resumePlay("s1");
    await tick();
    expect(captured.send).toHaveBeenCalledTimes(2);
    expect(captured.send.mock.calls[1]![0]).toMatchObject({ key: "F4" });
  });

  it("停止すると idle に戻り、以後は送らない（手で操作できる）", async () => {
    await open();
    macrosStore.macros = [macro([step(), step({ key: "F4" })])];

    play("s1", "m-1");
    await tick();
    stopPlay("s1");
    hostScreen();
    await tick();

    const rt = macroStateOf("s1")!;
    expect(rt.mode).toBe("idle");
    expect(rt.stopReason).toBe("user");
    expect(captured.send).toHaveBeenCalledTimes(1);
  });

  it("休止中に停止できる", async () => {
    await open();
    macrosStore.macros = [macro([step(), step({ key: "F4" })])];
    play("s1", "m-1");
    await tick();
    pausePlay("s1");
    stopPlay("s1");
    expect(macroStateOf("s1")!.mode).toBe("idle");
    expect(macroStateOf("s1")!.stopReason).toBe("user");
  });
});

describe("マクロ再生中は手入力を通さない", () => {
  /**
   * `busy` プロテクトだけでは足りない——応答が返ってから次のステップを送るまでの
   * **隙間で `busy` が false になる**ため、その瞬間の打鍵がホストへ抜けて再生と食い違う。
   * （test 工程で実際に F3 が抜けるのを再現して見つけた欠陥）
   */
  it("ステップ間の隙間で押した AID がホストへ届かない", async () => {
    await open();
    macrosStore.macros = [macro([step(), step({ key: "F4" })])];

    play("s1", "m-1");
    await tick();
    expect(captured.send).toHaveBeenCalledTimes(1);

    hostScreen(); // 応答が返り busy=false。ここが隙間
    sendKey("s1", "F3");

    const keys = captured.send.mock.calls.map((c) => (c[0] as { key: string }).key);
    expect(keys).not.toContain("F3");
  });

  it("再生中は GUI 選択・確定も通さない", async () => {
    await open();
    macrosStore.macros = [macro([step(), step({ key: "F4" })])];

    play("s1", "m-1");
    await tick();
    hostScreen();
    captured.send.mockClear();

    selectGuiChoice("s1", 1, 0, true);
    submitGuiSelection("s1", 1);

    const types = captured.send.mock.calls.map((c) => (c[0] as { type: string }).type);
    expect(types).not.toContain("gui-select");
    expect(types).not.toContain("gui-submit");
  });

  it("休止中は手入力を通す（入力してから再開するため）", async () => {
    await open();
    macrosStore.macros = [macro([step(), step({ key: "F4" })])];

    play("s1", "m-1");
    await tick();
    pausePlay("s1");
    hostScreen();
    captured.send.mockClear();

    sendKey("s1", "F3");
    expect(captured.send).toHaveBeenCalledTimes(1);
  });

  it("再生が終われば手入力は通常どおり通る", async () => {
    await open();
    macrosStore.macros = [macro([step()])];

    play("s1", "m-1");
    await tick();
    hostScreen();
    await tick();
    expect(macroStateOf("s1")!.mode).toBe("idle");
    captured.send.mockClear();

    sendKey("s1", "F3");
    expect(captured.send).toHaveBeenCalledTimes(1);
  });
});

describe("マクロ再生: 異常時は停止する（D9）", () => {
  it("画面が一致しなければ送らずに止まる", async () => {
    await open();
    macrosStore.macros = [macro([step({ screen: { rows: 24, cols: 80, targets: [{ field: 1, row: 9, col: 9, len: 10 }] } })])];

    play("s1", "m-1");
    await tick();

    expect(captured.send).not.toHaveBeenCalled();
    const rt = macroStateOf("s1")!;
    expect(rt.stopReason).toBe("mismatch");
    expect(rt.message).toContain("画面が一致しません");
  });

  it("2 ステップ目で画面が変われば、そこで止まる", async () => {
    await open();
    macrosStore.macros = [macro([step(), step({ key: "F4" })])];

    play("s1", "m-1");
    await tick();
    hostScreen([]); // 欄が消えた画面が返った
    await tick();

    expect(captured.send).toHaveBeenCalledTimes(1);
    expect(macroStateOf("s1")!.stopReason).toBe("mismatch");
  });

  it("切断されたら止まる", async () => {
    await open();
    macrosStore.macros = [macro([step(), step({ key: "F4" })])];

    play("s1", "m-1");
    await tick();
    captured.handlers.onServerMessage({ type: "closed" });
    await tick();

    expect(macroStateOf("s1")!.stopReason).toBe("disconnected");
  });

  it("readOnly セッションでは再生を始めない", async () => {
    await open({ readOnly: true });
    macrosStore.macros = [macro([step()])];

    play("s1", "m-1");
    await tick();

    expect(captured.send).not.toHaveBeenCalled();
    expect(macroStateOf("s1")!.stopReason).toBe("readonly");
  });

  it("切断中は再生を始めない", async () => {
    await open();
    macrosStore.macros = [macro([step()])];
    sessionsStore.get("s1")!.connected = false;

    play("s1", "m-1");
    await tick();

    expect(captured.send).not.toHaveBeenCalled();
    expect(macroStateOf("s1")!.stopReason).toBe("disconnected");
  });

  it("存在しないマクロは始めない", async () => {
    await open();
    play("s1", "m-nope");
    expect(macroStateOf("s1")!.stopReason).toBe("mismatch");
  });

  it("記録中には再生を始めない（排他）", async () => {
    await open();
    macrosStore.macros = [macro([step()])];
    sessionsStore.get("s1")!.macro = { mode: "recording", steps: [], index: 0 };

    play("s1", "m-1");
    await tick();

    expect(captured.send).not.toHaveBeenCalled();
    expect(macroStateOf("s1")!.mode).toBe("recording");
  });
});
