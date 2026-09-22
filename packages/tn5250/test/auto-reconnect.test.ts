import { describe, it, expect } from "vitest";
import { Session5250 } from "../src/session/session.js";
import type { Transport } from "../src/transport/types.js";
import { buildRecord } from "../src/protocol/gds.js";
import { ByteWriter } from "../src/protocol/bytes.js";
import { ESC, COMMAND, ORDER, OPCODE, FFW } from "../src/protocol/constants.js";
import { IAC, CMD } from "../src/telnet/constants.js";
import { codecForCcsid } from "@ts5250/ebcdic/codec";

/**
 * **ホストに切られたら自動で繋ぎ直す**（ACS `ECLConnection` の自動再接続。`20260921-auto-reconnect`）。
 *
 * 原典: 通信状態 2（通常の切断）のときだけ再接続スレッドを起こし、1 回目は即座、以後 20 秒おき・上限なし。
 * 自分から切ったとき・起動応答で拒否されたとき（状態 33/34）は繋ぎ直さない。
 * 実機: `SIGNOFF ENDCNN(*YES)` の直後に状態 2 となり、3 秒以内に新しいサインオン画面が出た。
 */
function frame(record: Uint8Array | number[]): Uint8Array {
  const framed: number[] = [];
  for (const b of record) {
    framed.push(b);
    if (b === IAC) framed.push(IAC);
  }
  framed.push(IAC, CMD.EOR);
  return Uint8Array.from(framed);
}
/** 入力欄 1 つの画面（解錠つき） */
function screenRecord(text: string): Uint8Array {
  const codec = codecForCcsid(37);
  const w = new ByteWriter();
  w.u8(ESC).u8(COMMAND.CLEAR_UNIT);
  w.u8(ESC).u8(COMMAND.WRITE_TO_DISPLAY).u8(0x00).u8(0x08);
  w.u8(ORDER.SBA).u8(1).u8(2);
  for (const b of codec.encode(text).bytes) w.u8(b);
  w.u8(ORDER.SBA).u8(5).u8(10);
  w.u8(ORDER.SF).u16(FFW.ID_VALUE).u8(0x20).u16(6);
  w.u8(ESC).u8(COMMAND.READ_MDT_FIELDS).u8(0x00).u8(0x00);
  return frame(buildRecord(OPCODE.PUT_GET, w.toUint8Array()));
}
/** 失敗の起動応答（装置名なし）。形式は `startup-reject.test.ts` と同じ */
function rejectRecord(code: string): Uint8Array {
  const codec = codecForCcsid(37);
  const head = [0x00, 0x00, 0x12, 0xa0, 0x90, 0x00, 0x05, 0x60, 0x06, 0x00, 0x20, 0xc0, 0x00, 0x3d, 0x00, 0x00];
  const rec = [...head, ...codec.encode(code).bytes];
  rec[1] = rec.length;
  return frame(rec);
}

/** 1 本の接続。`start` で初期レコードを流し、`hostClose` でホストから切る */
class Conn implements Transport {
  closed = false;
  readonly sent: Uint8Array[] = [];
  private dataFn: ((d: Uint8Array) => void) | undefined;
  private closeFn: ((reason: string) => void) | undefined;
  constructor(private readonly initial: Uint8Array | undefined) {}
  start(): void {
    if (this.initial) this.dataFn?.(this.initial);
  }
  send(d: Uint8Array): void {
    this.sent.push(d);
  }
  /** 確立した後にホストからレコードを届ける */
  deliver(bytes: Uint8Array): void {
    this.dataFn?.(bytes);
  }
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.closeFn?.("closed by client");
  }
  hostClose(reason = "closed by host"): void {
    if (this.closed) return;
    this.closed = true;
    this.closeFn?.(reason);
  }
  onData(fn: (d: Uint8Array) => void): void {
    this.dataFn = fn;
  }
  onClose(fn: (reason: string) => void): void {
    this.closeFn = fn;
  }
  onError(): void {}
}

/** 接続を順に配る。`plan` の要素: 画面 / 拒否 / 交渉中に切る / 繋がらない */
type Step =
  | { screen: string }
  | { reject: string }
  | { dropDuringNegotiation: true }
  | { refuse: true }
  /** 交渉のまま何も送らない（交渉中の切断を試す） */
  | { silent: true }
  /** TCP を張るのが終わらない（`release` で解く） */
  | { pendingConnect: true };
function factory(plan: Step[]) {
  const made: Conn[] = [];
  let i = 0;
  let release: (() => void) | undefined;
  const f = async (): Promise<Transport> => {
    const step = plan[Math.min(i++, plan.length - 1)]!;
    if ("refuse" in step) throw new Error("ECONNREFUSED");
    if ("pendingConnect" in step) {
      await new Promise<void>((r) => (release = r));
      const c = new Conn(screenRecord("LATE"));
      made.push(c);
      return c;
    }
    const c =
      "screen" in step ? new Conn(screenRecord(step.screen))
      : "reject" in step ? new Conn(rejectRecord(step.reject))
      : new Conn(undefined);
    made.push(c);
    if ("dropDuringNegotiation" in step) setTimeout(() => c.hostClose("reset during negotiation"), 5);
    return c;
  };
  return { f, made, calls: () => i, release: () => release?.() };
}
const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));
function events(s: Session5250) {
  const log: string[] = [];
  s.on("reconnecting", (e) => log.push(`reconnecting:${e.attempt}`));
  s.on("reconnected", () => log.push("reconnected"));
  s.on("closed", (r) => log.push(`closed:${r}`));
  return log;
}
const rowText = (s: Session5250, r: number) => s.snapshot().cells[r - 1]!.map((c) => c.char).join("").trim();

describe("自動再接続（autoReconnect）", () => {
  it("**ホストに切られたら即座に繋ぎ直し、新しい画面が出る**", async () => {
    const { f, made } = factory([{ screen: "FIRST" }, { screen: "SIGNON" }]);
    const s = await Session5250.connect({ id: "t", transportFactory: f, autoReconnect: true, reconnectIntervalMs: 50 });
    const log = events(s);
    expect(rowText(s, 1)).toBe("FIRST");
    s.messageWaiting = true; // 前の接続のメッセージ待ち表示
    made[0]!.hostClose("SIGNOFF ENDCNN");
    expect(s.currentState, "切られた直後は繋ぎ直し中").toBe("reconnecting");
    expect(s.snapshot().keyboardLocked).toBe(true);
    await tick(20);
    expect(log).toEqual(["reconnecting:1", "reconnected"]);
    expect(s.currentState).toBe("ready");
    expect(rowText(s, 1)).toBe("SIGNON");
    expect(s.messageWaiting, "前の接続のメッセージ待ちを持ち越した").toBe(false);
  });

  it("**既定では繋ぎ直さない**（ACS も ECL のコアは既定 false）", async () => {
    const { f, made, calls } = factory([{ screen: "FIRST" }, { screen: "SIGNON" }]);
    const s = await Session5250.connect({ id: "t", transportFactory: f });
    const log = events(s);
    made[0]!.hostClose("gone");
    await tick(20);
    expect(log).toEqual(["closed:gone"]);
    expect(calls()).toBe(1);
  });

  it("**自分から切ったら繋ぎ直さない**", async () => {
    const { f, calls } = factory([{ screen: "FIRST" }, { screen: "SIGNON" }]);
    const s = await Session5250.connect({ id: "t", transportFactory: f, autoReconnect: true });
    const log = events(s);
    s.disconnect();
    await tick(20);
    expect(log).toEqual(["closed:closed by client"]);
    expect(calls()).toBe(1);
  });

  it("**繋がらなければ間隔を置いて上限なく試し続ける**（1 回目は即座）", async () => {
    const { f, made } = factory([{ screen: "FIRST" }, { refuse: true }, { dropDuringNegotiation: true }, { screen: "BACK" }]);
    const s = await Session5250.connect({ id: "t", transportFactory: f, autoReconnect: true, reconnectIntervalMs: 40 });
    const log = events(s);
    made[0]!.hostClose();
    await tick(10);
    expect(log, "1 回目は即座").toEqual(["reconnecting:1"]);
    await tick(150);
    expect(log).toEqual(["reconnecting:1", "reconnecting:2", "reconnecting:3", "reconnected"]);
    expect(rowText(s, 1)).toBe("BACK");
  });

  it("**起動応答で拒否されたら諦める**（自動サインオンの失敗 8936 等。試し続けない）", async () => {
    const { f, made, calls } = factory([{ screen: "FIRST" }, { reject: "8936" }, { screen: "NEVER" }]);
    const s = await Session5250.connect({ id: "t", transportFactory: f, autoReconnect: true, reconnectIntervalMs: 30 });
    const log = events(s);
    made[0]!.hostClose();
    await tick(120);
    expect(log[0]).toBe("reconnecting:1");
    expect(log[1]).toMatch(/^closed:session rejected \(8936/);
    expect(log).toHaveLength(2);
    expect(calls(), "拒否のあとに試していない").toBe(2);
    expect(s.currentState).toBe("closed");
  });

  it("**待っている間に切ったら、それ以上試さない**", async () => {
    const { f, made, calls } = factory([{ screen: "FIRST" }, { refuse: true }, { screen: "NEVER" }]);
    const s = await Session5250.connect({ id: "t", transportFactory: f, autoReconnect: true, reconnectIntervalMs: 60 });
    const log = events(s);
    made[0]!.hostClose();
    await tick(10);
    s.disconnect();
    await tick(120);
    expect(log).toEqual(["reconnecting:1", "closed:disconnected"]);
    expect(calls()).toBe(2);
  });

  it("繋ぎ直している間は送れない（Attn・SysReq も。送り先が無い）", async () => {
    const { f, made } = factory([{ screen: "FIRST" }, { refuse: true }]);
    const s = await Session5250.connect({ id: "t", transportFactory: f, autoReconnect: true, reconnectIntervalMs: 1000 });
    made[0]!.hostClose();
    // 閉じたセッションと同じく同期で投げる
    expect(() => s.sendAid("Enter")).toThrow(expect.objectContaining({ code: "KEYBOARD_LOCKED" }));
    expect(() => s.sendAid("Attn")).toThrow(expect.objectContaining({ code: "KEYBOARD_LOCKED" }));
    s.disconnect();
  });

  it("応答待ちの AID は、切られたところで時間切れとして返る", async () => {
    const { f, made } = factory([{ screen: "FIRST" }, { screen: "SIGNON" }]);
    const s = await Session5250.connect({ id: "t", transportFactory: f, autoReconnect: true });
    const p = s.sendAid("Enter", { timeoutMs: "never" });
    made[0]!.hostClose();
    await expect(p).resolves.toMatchObject({ timedOut: true });
    await tick(20);
    s.disconnect();
  });
});

/** 実機の受信レコード（`STRPCCMD ... PAUSE(*YES)`。`pc-command-session.test.ts` と同じもの） */
const REC_PAUSE_YES = Uint8Array.from(
  (
    "010b12a0000004000003044004110028010700000019000000150009d960018000000011010227402040004040004027" +
    "40201102022740204000404000402740201101011d482027040a111012200e47ca4655449642d742c343d743bb43c243" +
    "ad43a60f4dd7c3d64bc5e7c55d0e44c047b445e4485248fd4497449644564494448244a4448f44bd43410f2011111220" +
    "0e42d742c3449545e345a5448e44af448a4495449d44cd448744a4448f44bd43410f4020111212200e48eb46cd499044" +
    "8e44af449144a74497449d426b45ed45a443874358444649e1448d4494448844ca448c448243410f201101012780fcd7" +
    "c3d6408380a180808583889640e6c1c9e3d4c5020d4b0004520000"
  )
    .match(/../g)!
    .map((h) => parseInt(h, 16))
);

describe("自動再接続（独立点検の指摘）", () => {
  it("**TCP を張っている最中に切ったら、張れても生き返らない**", async () => {
    const { f, made, release } = factory([{ screen: "FIRST" }, { pendingConnect: true }]);
    const s = await Session5250.connect({ id: "t", transportFactory: f, autoReconnect: true });
    const log = events(s);
    made[0]!.hostClose();
    await tick(10);
    s.disconnect();
    release();
    await tick(20);
    expect(log).toEqual(["reconnecting:1", "closed:disconnected"]);
    expect(made[1]!.closed, "張れた接続を閉じていない").toBe(true);
    expect(s.currentState).toBe("closed");
  });

  it("**繋ぎ直しの交渉中に切ったら、生き返らない**", async () => {
    const { f, made } = factory([{ screen: "FIRST" }, { silent: true }]);
    const s = await Session5250.connect({ id: "t", transportFactory: f, autoReconnect: true, negotiationTimeoutMs: 5000 });
    const log = events(s);
    made[0]!.hostClose();
    await tick(10);
    s.disconnect();
    await tick(20);
    expect(log).toEqual(["reconnecting:1", "closed:disconnected"]);
    expect(s.currentState).toBe("closed");
  });

  it("**交渉中も「繋ぎ直し中」のまま**で、送れない（交渉途中の接続へ流さない）", async () => {
    const { f, made } = factory([{ screen: "FIRST" }, { silent: true }]);
    const s = await Session5250.connect({ id: "t", transportFactory: f, autoReconnect: true, negotiationTimeoutMs: 5000 });
    made[0]!.hostClose();
    await tick(10);
    expect(s.currentState).toBe("reconnecting");
    expect(() => s.sendAid("Attn")).toThrow(expect.objectContaining({ code: "KEYBOARD_LOCKED" }));
    s.disconnect();
  });

  it("**失敗した試行のあとも前の画面を残す**（最初のレコードまで作り直さない）", async () => {
    const { f, made } = factory([{ screen: "FIRST" }, { dropDuringNegotiation: true }, { refuse: true }]);
    const s = await Session5250.connect({ id: "t", transportFactory: f, autoReconnect: true, reconnectIntervalMs: 1000 });
    made[0]!.hostClose();
    await tick(30);
    expect(rowText(s, 1), "失敗した試行で画面が白くなった").toBe("FIRST");
    s.disconnect();
  });

  it("購読者が投げても繋ぎ直しは続き、確立した接続を失敗と取り違えない", async () => {
    const { f, made, calls } = factory([{ screen: "FIRST" }, { screen: "SIGNON" }]);
    const warnings: string[] = [];
    const s = await Session5250.connect({
      id: "t", transportFactory: f, autoReconnect: true, reconnectIntervalMs: 30, warn: (m) => warnings.push(m)
    });
    s.on("reconnecting", () => {
      throw new Error("listener");
    });
    s.on("reconnected", () => {
      throw new Error("listener");
    });
    made[0]!.hostClose();
    await tick(100);
    expect(s.currentState).toBe("ready");
    expect(calls(), "2 本目を張った").toBe(2);
    // 両方の例外をこちらで拾った（拾わないとタイマーの中で未処理の rejection になる）
    expect(warnings.filter((w) => w.includes("reconnect listener failed"))).toHaveLength(2);
    s.disconnect();
  });

  it("**前の接続で始まった PC コマンドの完了応答を、張り直した接続へ送らない**", async () => {
    const { f, made } = factory([{ screen: "FIRST" }, { screen: "SIGNON" }]);
    let finish: (() => void) | undefined;
    const s = await Session5250.connect({
      id: "t", transportFactory: f, autoReconnect: true,
      onPcCommand: () => new Promise<void>((r) => (finish = r))
    });
    made[0]!.deliver(Uint8Array.from([...REC_PAUSE_YES, 0xff, 0xef])); // PAUSE(*YES): 完了を待ってから Enter を返す
    await tick(5);
    expect(finish, "前提: PC コマンドが始まった").toBeDefined();
    made[0]!.hostClose();
    await tick(20);
    expect(s.currentState, "前提: 繋ぎ直した").toBe("ready");
    const before = made[1]!.sent.length;
    finish!();
    await tick(10);
    expect(made[1]!.sent.length, "新しい接続へ前のジョブ宛の応答を送った").toBe(before);
    s.disconnect();
  });
});
