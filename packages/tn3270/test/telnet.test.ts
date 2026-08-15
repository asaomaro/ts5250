import { describe, it, expect } from "vitest";
import { TelnetLayer } from "../src/telnet/telnet.js";
import type { Transport } from "../src/transport/types.js";
import { IAC, CMD, OPT, TT_IS, TT_SEND } from "../src/telnet/constants.js";

/** テスト用の Transport。送信バイトを溜め、任意のバイト列を受信として流し込める */
class MockTransport implements Transport {
  sent: number[][] = [];
  private dataFn: ((d: Uint8Array) => void) | undefined;
  send(data: Uint8Array): void {
    this.sent.push([...data]);
  }
  close(): void {}
  onData(fn: (d: Uint8Array) => void): void {
    this.dataFn = fn;
  }
  onClose(): void {}
  onError(): void {}
  /** ホストから届いたことにする */
  recv(...bytes: number[]): void {
    this.dataFn?.(Uint8Array.from(bytes));
  }
  get sentFlat(): number[] {
    return this.sent.flat();
  }
}

function hex(bytes: number[]): string {
  return bytes.map((b) => b.toString(16).padStart(2, "0")).join("");
}

describe("基本 TN3270 の telnet 交渉（research F2 の実測列）", () => {
  it("Hercules と同じ並びで交渉が成立する", () => {
    const t = new MockTransport();
    const telnet = new TelnetLayer(t, { terminalType: "IBM-3279-2-E" });
    let negotiated = false;
    telnet.onNegotiated(() => (negotiated = true));

    // < fffd18  DO TERMINAL-TYPE
    t.recv(IAC, CMD.DO, OPT.TERMINAL_TYPE);
    expect(hex(t.sentFlat)).toBe("fffb18"); // > WILL TERMINAL-TYPE

    // < fffa1801fff0  SB TERMINAL-TYPE SEND
    t.sent = [];
    t.recv(IAC, CMD.SB, OPT.TERMINAL_TYPE, TT_SEND, IAC, CMD.SE);
    // > SB TERMINAL-TYPE IS "IBM-3279-2-E" SE
    const expected = [IAC, CMD.SB, OPT.TERMINAL_TYPE, TT_IS];
    for (const c of "IBM-3279-2-E") expected.push(c.charCodeAt(0));
    expected.push(IAC, CMD.SE);
    expect(hex(t.sentFlat)).toBe(hex(expected));

    // < fffd19 fffb19  DO / WILL END-OF-RECORD
    t.sent = [];
    t.recv(IAC, CMD.DO, OPT.END_OF_RECORD, IAC, CMD.WILL, OPT.END_OF_RECORD);
    expect(hex(t.sentFlat)).toBe("fffb19fffd19"); // WILL EOR, DO EOR
    expect(negotiated).toBe(false); // BINARY がまだ

    // < fffd00 fffb00  DO / WILL BINARY
    t.sent = [];
    t.recv(IAC, CMD.DO, OPT.BINARY, IAC, CMD.WILL, OPT.BINARY);
    expect(hex(t.sentFlat)).toBe("fffb00fffd00"); // WILL BINARY, DO BINARY
    expect(negotiated).toBe(true); // BINARY + EOR が揃って 3270 モード
  });

  it("知らないオプションは断る（落とさない）", () => {
    const t = new MockTransport();
    new TelnetLayer(t, { terminalType: "IBM-3279-2-E" });
    // SGA(3) は 5250 では使うが 3270 では出てこない。来ても断って続行する
    t.recv(IAC, CMD.DO, 0x03);
    expect(hex(t.sentFlat)).toBe("fffc03"); // WONT SGA
    t.sent = [];
    t.recv(IAC, CMD.WILL, 0x27); // NEW-ENVIRON(39)
    expect(hex(t.sentFlat)).toBe("fffe27"); // DONT
  });
});

describe("レコードの切り出し（IAC EOR）", () => {
  it("IAC EOR ごとに 1 レコードとして渡す", () => {
    const t = new MockTransport();
    const telnet = new TelnetLayer(t, { terminalType: "X" });
    const got: string[] = [];
    telnet.onRecord((r) => got.push(hex([...r])));

    t.recv(0xf5, 0xc3, 0x11, 0x40, 0x40, IAC, CMD.EOR, 0xf1, 0xc2, IAC, CMD.EOR);
    expect(got).toEqual(["f5c3114040", "f1c2"]);
  });

  it("本文中の IAC 二重化を解除する", () => {
    const t = new MockTransport();
    const telnet = new TelnetLayer(t, { terminalType: "X" });
    const got: string[] = [];
    telnet.onRecord((r) => got.push(hex([...r])));

    // データに 0xFF が含まれると FF FF で送られてくる
    t.recv(0xf5, IAC, IAC, 0xc3, IAC, CMD.EOR);
    expect(got).toEqual(["f5ffc3"]);
  });

  it("**chunk が telnet 列の途中で切れても壊れない**", () => {
    // TCP はどこで切れるか分からない。分割されたときだけ交渉が壊れるのが最悪
    const t = new MockTransport();
    const telnet = new TelnetLayer(t, { terminalType: "IBM-3279-2-E" });
    const got: string[] = [];
    telnet.onRecord((r) => got.push(hex([...r])));

    t.recv(IAC); // IAC だけで切れた
    expect(t.sentFlat).toEqual([]); // まだ何も返さない
    t.recv(CMD.DO); // コマンドだけ来た
    expect(t.sentFlat).toEqual([]); // オプション番号待ち
    t.recv(OPT.TERMINAL_TYPE); // ここで初めて完成
    expect(hex(t.sentFlat)).toBe("fffb18");

    // SB も途中で切れる
    t.sent = [];
    t.recv(IAC, CMD.SB, OPT.TERMINAL_TYPE);
    expect(t.sentFlat).toEqual([]); // SE 待ち
    t.recv(TT_SEND, IAC, CMD.SE);
    expect(hex(t.sentFlat).startsWith("fffa1800")).toBe(true);

    // レコードも途中で切れる
    t.sent = [];
    t.recv(0xf5, 0xc3);
    expect(got).toEqual([]);
    t.recv(0x11, IAC);
    expect(got).toEqual([]);
    t.recv(CMD.EOR);
    expect(got).toEqual(["f5c311"]);
  });
});

describe("送信（sendRecord）", () => {
  it("IAC を二重化し末尾に IAC EOR を付ける", () => {
    const t = new MockTransport();
    const telnet = new TelnetLayer(t, { terminalType: "X" });
    telnet.sendRecord(Uint8Array.from([0x7d, 0x40, 0x40]));
    expect(hex(t.sentFlat)).toBe("7d4040ffef");

    t.sent = [];
    telnet.sendRecord(Uint8Array.from([0x7d, 0xff, 0x40]));
    expect(hex(t.sentFlat)).toBe("7dffff40ffef");
  });
});

describe("交渉ループの防止（RFC 854）", () => {
  it("同じオプションを繰り返し要求されても 1 度しか応答しない", () => {
    // 双方が肯定応答を返し続けると**交渉が無限ループする**。
    // Hercules は 1 回しか送らないので実測では踏まないが、踏んだら黙ってループするので塞ぐ
    const t = new MockTransport();
    new TelnetLayer(t, { terminalType: "IBM-3279-2-E" });

    t.recv(IAC, CMD.DO, OPT.BINARY);
    expect(hex(t.sentFlat)).toBe("fffb00");

    t.sent = [];
    t.recv(IAC, CMD.DO, OPT.BINARY); // 2 回目
    expect(t.sentFlat).toEqual([]); // 応答しない

    t.recv(IAC, CMD.DO, OPT.BINARY, IAC, CMD.DO, OPT.BINARY); // 何回来ても
    expect(t.sentFlat).toEqual([]);
  });

  it("知らないオプションの拒否も 1 度だけ", () => {
    const t = new MockTransport();
    new TelnetLayer(t, { terminalType: "X" });
    t.recv(IAC, CMD.DO, 0x03); // SGA
    expect(hex(t.sentFlat)).toBe("fffc03");
    t.sent = [];
    t.recv(IAC, CMD.DO, 0x03);
    expect(t.sentFlat).toEqual([]);
  });
});
