import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Field, ScreenSnapshot } from "@as400web/core";

// WsClient をモック（busy-loading.test.ts と同じ体裁）
let captured: { handlers: { onServerMessage: (m: unknown) => void }; send: ReturnType<typeof vi.fn> };
vi.mock("../src/ws-client.js", () => ({
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
import {
  startRecording,
  pauseRecording,
  resumeRecording,
  stopRecording,
  recordSend,
  pendingSecrets,
  macroStateOf,
  isRecording
} from "../src/macro-record.js";

/**
 * 記録の要点は 2 つ（spec D1・D5）:
 *   - 画面単位で「AID ＋ 編集した欄」を積む（打鍵列ではない）
 *   - **非表示（パスワード）欄の値を draft の外へ出さない**
 * そして `idle` のときは既存の送信挙動を一切変えないこと（受け入れ基準 A8）。
 */

const DUMMY_SECRET = "dummy-secret-value";

function field(over: Partial<Field> & { index: number }): Field {
  return {
    row: 1,
    col: 1,
    length: 10,
    protected: false,
    hidden: false,
    numeric: false,
    mdt: false,
    value: "",
    ...over
  };
}

/** signon 相当の画面（index 1=ユーザー欄 / index 2=パスワード欄＝hidden） */
function snap(fields: Field[] = []): ScreenSnapshot {
  return {
    sessionId: "s1",
    rows: 24,
    cols: 80,
    cursor: { row: 5, col: 25 },
    keyboardLocked: false,
    cells: [],
    fields
  };
}

const SIGNON_FIELDS = [
  field({ index: 1, row: 5, col: 25, length: 10 }),
  field({ index: 2, row: 6, col: 25, length: 128, hidden: true })
];

async function open(fields: Field[] = SIGNON_FIELDS): Promise<void> {
  sessionsStore.byId.clear();
  sessionsStore.order = [];
  const p = openSession({ type: "open", host: "h" }, "t");
  captured.handlers.onServerMessage({ type: "opened", sessionId: "s1", screen: snap(fields) });
  await p;
  captured.send.mockClear();
}

/** ホストからの新画面到着（busy 解除＋ edits クリア） */
function hostScreen(fields: Field[] = SIGNON_FIELDS): void {
  captured.handlers.onServerMessage({ type: "screen", screen: snap(fields) });
}

beforeEach(() => {
  macrosStore.macros = [];
  macrosStore.canStoreSecrets = true;
});

describe("マクロ記録: 状態遷移", () => {
  it("開始・休止・再開・停止で mode が動く", async () => {
    await open();
    expect(macroStateOf("s1")).toBeUndefined();

    startRecording("s1");
    expect(macroStateOf("s1")?.mode).toBe("recording");
    expect(isRecording("s1")).toBe(true);

    pauseRecording("s1");
    expect(macroStateOf("s1")?.mode).toBe("recordPaused");

    resumeRecording("s1");
    expect(macroStateOf("s1")?.mode).toBe("recording");

    await stopRecording("s1", false);
    expect(macroStateOf("s1")?.mode).toBe("idle");
    expect(isRecording("s1")).toBe(false);
  });

  it("記録中に再度 startRecording しても積んだステップを捨てない", async () => {
    await open();
    startRecording("s1");
    const s = sessionsStore.get("s1")!;
    s.edits.set(1, "USER");
    sendKey("s1", "Enter");
    expect(macroStateOf("s1")?.steps).toHaveLength(1);

    startRecording("s1"); // 排他: 無視される
    expect(macroStateOf("s1")?.steps).toHaveLength(1);
  });
});

describe("マクロ記録: 何が積まれるか", () => {
  it("画面ごとに「AID ＋ 編集した欄」を 1 ステップとして積む", async () => {
    await open();
    startRecording("s1");
    const s = sessionsStore.get("s1")!;

    s.edits.set(1, "USER");
    sendKey("s1", "Enter", { row: 5, col: 25 });
    hostScreen();

    s.edits.set(1, "WRKACTJOB");
    sendKey("s1", "F4", { row: 5, col: 25 });

    const steps = macroStateOf("s1")!.steps;
    expect(steps).toHaveLength(2);
    expect(steps[0]).toMatchObject({ key: "Enter", fields: [{ field: 1, value: "USER" }] });
    expect(steps[1]).toMatchObject({ key: "F4", fields: [{ field: 1, value: "WRKACTJOB" }] });
  });

  it("照合材料（画面サイズと書き込む欄の座標・長さ）を一緒に積む", async () => {
    await open();
    startRecording("s1");
    const s = sessionsStore.get("s1")!;
    s.edits.set(1, "USER");
    sendKey("s1", "Enter");

    expect(macroStateOf("s1")!.steps[0]!.screen).toEqual({
      rows: 24,
      cols: 80,
      targets: [{ field: 1, row: 5, col: 25, len: 10 }]
    });
  });

  it("SysReq はシステム要求行の文字列も一緒に積む", async () => {
    await open();
    startRecording("s1");
    sendKey("s1", "SysReq", { row: 1, col: 1 }, "2");
    expect(macroStateOf("s1")!.steps[0]).toMatchObject({ key: "SysReq", sysReqText: "2" });
  });

  it("休止中の送信は積まない（送信自体は通常どおり行う）", async () => {
    await open();
    startRecording("s1");
    pauseRecording("s1");
    const s = sessionsStore.get("s1")!;
    s.edits.set(1, "USER");
    sendKey("s1", "Enter");

    expect(macroStateOf("s1")!.steps).toHaveLength(0);
    expect(captured.send).toHaveBeenCalledTimes(1); // ホストへは送られている
  });

  it("画面から消えた欄は記録しない（書き込み先を特定できないため）", async () => {
    await open();
    startRecording("s1");
    const s = sessionsStore.get("s1")!;
    s.edits.set(1, "USER");
    s.edits.set(99, "存在しない欄");
    sendKey("s1", "Enter");

    const step = macroStateOf("s1")!.steps[0]!;
    expect(step.fields).toEqual([{ field: 1, value: "USER" }]);
    expect(step.screen.targets).toHaveLength(1);
  });

  it("拡張5250 の選択フィールド送信は記録できない印を立てる", async () => {
    await open();
    startRecording("s1");
    submitGuiSelection("s1", 7);
    expect(macroStateOf("s1")!.incomplete).toBe(true);
  });

  it("選択の切り替えだけでも印を立てる（選択が抜けたマクロを黙って作らない）", async () => {
    await open();
    startRecording("s1");
    // 切り替えは s.edits に現れないため、これを記録できないまま Enter だけ積むと
    // 「選択が反映されないのに Enter が飛ぶ」マクロになる（review ラウンド1 の指摘）
    selectGuiChoice("s1", 7, 0, true);
    expect(macroStateOf("s1")!.incomplete).toBe(true);
  });
});

describe("マクロ記録: 秘密（パスワード）の隔離", () => {
  it("hidden 欄の値は fields ではなく secrets に入る", async () => {
    await open();
    startRecording("s1");
    const s = sessionsStore.get("s1")!;
    s.edits.set(1, "USER");
    s.edits.set(2, DUMMY_SECRET);
    sendKey("s1", "Enter");

    const step = macroStateOf("s1")!.steps[0]!;
    expect(step.fields).toEqual([{ field: 1, value: "USER" }]);
    expect(step.secrets).toEqual([{ field: 2, value: DUMMY_SECRET }]);
    // 通常の欄側には平文が混ざらない
    expect(JSON.stringify(step.fields)).not.toContain(DUMMY_SECRET);
  });

  it("pendingSecrets は在りかだけを返し、値を返さない", async () => {
    await open();
    startRecording("s1");
    const s = sessionsStore.get("s1")!;
    s.edits.set(2, DUMMY_SECRET);
    sendKey("s1", "Enter");

    const pending = pendingSecrets("s1");
    expect(pending).toEqual([{ key: "0:2", step: 0, field: 2, row: 6, col: 25 }]);
    expect(JSON.stringify(pending)).not.toContain(DUMMY_SECRET);
  });

  it("「保存する」を選ぶと plainSecrets として 1 回だけ送られる", async () => {
    await open();
    const create = vi.spyOn(macrosStore, "create").mockResolvedValue({
      id: "m-1",
      name: "n",
      createdAt: 0,
      updatedAt: 0,
      hasSecret: true,
      steps: []
    });
    startRecording("s1");
    const s = sessionsStore.get("s1")!;
    s.edits.set(1, "USER");
    s.edits.set(2, DUMMY_SECRET);
    sendKey("s1", "Enter");

    await stopRecording("s1", true, "サインオン", { "0:2": "store" });

    const body = create.mock.calls[0]![0];
    expect(body.steps[0]!.plainSecrets).toEqual([{ field: 2, value: DUMMY_SECRET }]);
    expect(body.steps[0]!.promptFields).toBeUndefined();
    create.mockRestore();
  });

  it("「毎回入力する」を選ぶと平文を送らず promptFields だけになる", async () => {
    await open();
    const create = vi.spyOn(macrosStore, "create").mockResolvedValue({
      id: "m-1", name: "n", createdAt: 0, updatedAt: 0, hasSecret: false, steps: []
    });
    startRecording("s1");
    const s = sessionsStore.get("s1")!;
    s.edits.set(2, DUMMY_SECRET);
    sendKey("s1", "Enter");

    await stopRecording("s1", true, "サインオン", { "0:2": "prompt" });

    const body = create.mock.calls[0]![0];
    expect(body.steps[0]!.plainSecrets).toBeUndefined();
    expect(body.steps[0]!.promptFields).toEqual([2]);
    expect(JSON.stringify(body)).not.toContain(DUMMY_SECRET);
    create.mockRestore();
  });

  it("「記録しない」を選ぶと欄ごと消える", async () => {
    await open();
    const create = vi.spyOn(macrosStore, "create").mockResolvedValue({
      id: "m-1", name: "n", createdAt: 0, updatedAt: 0, hasSecret: false, steps: []
    });
    startRecording("s1");
    const s = sessionsStore.get("s1")!;
    s.edits.set(2, DUMMY_SECRET);
    sendKey("s1", "Enter");

    await stopRecording("s1", true, "サインオン", { "0:2": "skip" });

    const body = create.mock.calls[0]![0];
    expect(body.steps[0]!.plainSecrets).toBeUndefined();
    expect(body.steps[0]!.promptFields).toBeUndefined();
    expect(JSON.stringify(body)).not.toContain(DUMMY_SECRET);
    create.mockRestore();
  });

  it("サーバーに鍵が無ければ既定は「毎回入力する」（保存が 400 で落ちて記録を失わない）", async () => {
    await open();
    macrosStore.canStoreSecrets = false;
    const create = vi.spyOn(macrosStore, "create").mockResolvedValue({
      id: "m-1", name: "n", createdAt: 0, updatedAt: 0, hasSecret: false, steps: []
    });
    startRecording("s1");
    const s = sessionsStore.get("s1")!;
    s.edits.set(2, DUMMY_SECRET);
    sendKey("s1", "Enter");

    await stopRecording("s1", true, "サインオン"); // choices 未指定

    const body = create.mock.calls[0]![0];
    expect(body.steps[0]!.promptFields).toEqual([2]);
    expect(JSON.stringify(body)).not.toContain(DUMMY_SECRET);
    create.mockRestore();
  });

  it("破棄すると何も送らず、draft の平文も消える", async () => {
    await open();
    const create = vi.spyOn(macrosStore, "create");
    startRecording("s1");
    const s = sessionsStore.get("s1")!;
    s.edits.set(2, DUMMY_SECRET);
    sendKey("s1", "Enter");
    const steps = macroStateOf("s1")!.steps;

    await stopRecording("s1", false);

    expect(create).not.toHaveBeenCalled();
    expect(steps).toHaveLength(0); // draft ごと空になる
    create.mockRestore();
  });

  it("保存後も draft に平文が残らない", async () => {
    await open();
    const create = vi.spyOn(macrosStore, "create").mockResolvedValue({
      id: "m-1", name: "n", createdAt: 0, updatedAt: 0, hasSecret: true, steps: []
    });
    startRecording("s1");
    const s = sessionsStore.get("s1")!;
    s.edits.set(2, DUMMY_SECRET);
    sendKey("s1", "Enter");
    const steps = macroStateOf("s1")!.steps;

    await stopRecording("s1", true, "サインオン", { "0:2": "store" });

    expect(steps).toHaveLength(0);
    create.mockRestore();
  });

  it("保存に失敗しても記録中のまま取り残されず、平文も残らない", async () => {
    await open();
    const create = vi.spyOn(macrosStore, "create").mockRejectedValue(new Error("boom"));
    startRecording("s1");
    const s = sessionsStore.get("s1")!;
    s.edits.set(2, DUMMY_SECRET);
    sendKey("s1", "Enter");
    const steps = macroStateOf("s1")!.steps;

    await expect(stopRecording("s1", true, "サインオン", { "0:2": "store" })).rejects.toThrow("boom");

    expect(macroStateOf("s1")?.mode).toBe("idle");
    expect(steps).toHaveLength(0);
    create.mockRestore();
  });

  it("ステップ 0 件では保存しない（空マクロを作らない）", async () => {
    await open();
    const create = vi.spyOn(macrosStore, "create");
    startRecording("s1");
    await stopRecording("s1", true, "空");
    expect(create).not.toHaveBeenCalled();
    create.mockRestore();
  });
});

describe("マクロ記録: 既存挙動への非回帰（A8）", () => {
  it("記録していないとき sendKey は従来どおり送り、マクロ状態を作らない", async () => {
    await open();
    const s = sessionsStore.get("s1")!;
    s.edits.set(1, "USER");
    sendKey("s1", "Enter", { row: 5, col: 25 });

    expect(captured.send).toHaveBeenCalledWith({
      type: "key",
      key: "Enter",
      cursor: { row: 5, col: 25 },
      fields: [{ field: 1, value: "USER" }]
    });
    expect(macroStateOf("s1")).toBeUndefined();
  });

  it("busy 中の送信は従来どおり弾かれ、記録も積まれない", async () => {
    await open();
    startRecording("s1");
    const s = sessionsStore.get("s1")!;
    sendKey("s1", "Enter");
    expect(s.busy).toBe(true);

    sendKey("s1", "Enter"); // プロテクト中
    expect(captured.send).toHaveBeenCalledTimes(1);
    expect(macroStateOf("s1")!.steps).toHaveLength(1);
  });

  it("recordSend を直接呼んでも idle なら何も起きない", async () => {
    await open();
    recordSend("s1", "Enter", { row: 1, col: 1 });
    expect(macroStateOf("s1")).toBeUndefined();
  });

  it("存在しないセッションへの操作は無視される", () => {
    expect(() => startRecording("nope")).not.toThrow();
    expect(() => recordSend("nope", "Enter", { row: 1, col: 1 })).not.toThrow();
    expect(macroStateOf("nope")).toBeUndefined();
  });
});
