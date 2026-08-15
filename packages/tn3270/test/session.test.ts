import { describe, it, expect } from "vitest";
import { Tn3270Session } from "../src/session/session.js";
import type { Transport } from "../src/transport/types.js";
import { encodeAddress } from "../src/protocol/address.js";
import { CMD3270, ORDER, WCC } from "../src/protocol/constants.js";
import { IAC, CMD, OPT, TT_SEND } from "../src/telnet/constants.js";

class MockTransport implements Transport {
  sent: number[][] = [];
  private dataFn: ((d: Uint8Array) => void) | undefined;
  private closeFn: ((r: string) => void) | undefined;
  send(data: Uint8Array): void {
    this.sent.push([...data]);
  }
  close(): void {
    this.closeFn?.("closed");
  }
  onData(fn: (d: Uint8Array) => void): void {
    this.dataFn = fn;
  }
  onClose(fn: (r: string) => void): void {
    this.closeFn = fn;
  }
  onError(): void {}
  recv(...b: number[]): void {
    this.dataFn?.(Uint8Array.from(b));
  }
  /** アプリのレコードを 1 つ流す（IAC EOR 付き） */
  recvRecord(bytes: number[]): void {
    this.recv(...bytes, IAC, CMD.EOR);
  }
  get lastRecord(): string {
    const flat = this.sent[this.sent.length - 1] ?? [];
    return flat.map((b) => b.toString(16).padStart(2, "0")).join("");
  }
}

const sba = (a: number): number[] => [ORDER.SBA, ...encodeAddress(a)];

/** 交渉を済ませたセッションを作る */
function connected(): { s: Tn3270Session; t: MockTransport } {
  const t = new MockTransport();
  const s = new Tn3270Session({ host: "x", model: 2 });
  s.attach(t);
  t.recv(IAC, CMD.DO, OPT.TERMINAL_TYPE);
  t.recv(IAC, CMD.SB, OPT.TERMINAL_TYPE, TT_SEND, IAC, CMD.SE);
  t.recv(IAC, CMD.DO, OPT.END_OF_RECORD, IAC, CMD.WILL, OPT.END_OF_RECORD);
  t.recv(IAC, CMD.DO, OPT.BINARY, IAC, CMD.WILL, OPT.BINARY);
  return { s, t };
}

/** 非保護欄（属性桁 0）と保護欄（属性桁 20）を持つ画面を流す */
function sendScreen(t: MockTransport): void {
  t.recvRecord([
    CMD3270.ERASE_WRITE, WCC.RESTORE,
    ...sba(0), ORDER.SF, 0x00,
    ...sba(20), ORDER.SF, 0x20,
    ...sba(1), ORDER.IC
  ]);
}

describe("状態機械", () => {
  it("交渉が終わると ready になる", () => {
    const { s } = connected();
    expect(s.status).toBe("ready");
  });

  it("AID を送るとロックされ、WCC の restore で戻る", () => {
    const { s, t } = connected();
    sendScreen(t);
    expect(s.status).toBe("ready");
    s.send("enter");
    expect(s.status).toBe("locked");
    t.recvRecord([CMD3270.WRITE, WCC.RESTORE]);
    expect(s.status).toBe("ready");
  });

  it("ロック中の入力は KEYBOARD_LOCKED で拒否する", () => {
    const { s, t } = connected();
    sendScreen(t);
    s.send("enter");
    expect(() => s.type("A")).toThrow(/keyboard is locked/);
    expect(() => s.send("pf1")).toThrow(/keyboard is locked/);
  });

  it("閉じたセッションは使えない", () => {
    const { s, t } = connected();
    sendScreen(t);
    s.close();
    expect(() => s.type("A")).toThrow(/session is closed/);
  });
});

describe("入力", () => {
  it("非保護欄に書けて MDT が立つ", () => {
    const { s, t } = connected();
    sendScreen(t);
    s.setCursor(1, 2);
    s.type("AB");
    const mod = s.modifiedFields();
    expect(mod.length).toBe(1);
    expect(mod[0]!.value.startsWith("AB")).toBe(true);
  });

  it("保護欄への入力は FIELD_PROTECTED で拒否する", () => {
    const { s, t } = connected();
    sendScreen(t);
    s.setCursor(1, 22); // 属性桁 20 の次＝保護欄の中身
    expect(() => s.type("A")).toThrow(/protected/);
  });

  it("属性桁そのものへの入力も拒否する", () => {
    const { s, t } = connected();
    sendScreen(t);
    s.setCursor(1, 1); // 属性桁
    expect(() => s.type("A")).toThrow(/field attribute/);
  });

  it("画面外へのカーソル移動は拒否する", () => {
    const { s, t } = connected();
    sendScreen(t);
    expect(() => s.setCursor(99, 1)).toThrow(/out of screen/);
  });
});

describe("送信バイト", () => {
  it("入力後の Enter に変更欄の内容が乗る", () => {
    const { s, t } = connected();
    sendScreen(t);
    s.setCursor(1, 2);
    s.type("AB");
    s.send("enter");
    // AID(7d) + カーソル + SBA + 欄の先頭 + "AB"(c1c2) + IAC EOR(ffef)
    expect(t.lastRecord.startsWith("7d")).toBe(true);
    expect(t.lastRecord).toMatch(/11.{4}c1c2ffef$/);
  });

  it("PA1 は AID 1 バイトだけ（実測）", () => {
    const { s, t } = connected();
    sendScreen(t);
    s.send("pa1");
    expect(t.lastRecord).toBe("6cffef");
  });

  it("Clear は画面を消す", () => {
    const { s, t } = connected();
    sendScreen(t);
    s.setCursor(1, 2);
    s.type("AB");
    s.send("clear");
    expect(t.lastRecord).toBe("6dffef");
    expect(s.snapshot().unformatted).toBe(true); // 消えたので属性桁も無い
  });
});

describe("ホスト起動の読み取りに応答する", () => {
  it("Read Modified コマンドに AID 0x60 で返す", () => {
    const { s, t } = connected();
    sendScreen(t);
    s.setCursor(1, 2);
    s.type("AB");
    const before = t.sent.length;
    t.recvRecord([CMD3270.READ_MODIFIED]);
    expect(t.sent.length).toBeGreaterThan(before);
    expect(t.lastRecord.startsWith("60")).toBe(true);
    expect(t.lastRecord).toMatch(/11.{4}c1c2ffef$/);
  });
});

describe("画面イベント", () => {
  it("受信のたびに snapshot が飛ぶ", () => {
    const { s, t } = connected();
    const seen: number[] = [];
    s.on("screen", (snap) => seen.push(snap.fields.length));
    sendScreen(t);
    expect(seen.length).toBe(1);
    expect(seen[0]).toBe(2);
  });
});
