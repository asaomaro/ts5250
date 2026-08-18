import { describe, it, expect } from "vitest";
import { TelnetLayer } from "../src/telnet/telnet.js";
import type { Transport } from "../src/transport/types.js";
import { IAC, CMD, OPT, TT_IS, TT_SEND, ENV_IS, ENV_SEND } from "../src/telnet/constants.js";

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
    t.recv(IAC, CMD.WILL, 0x2c); // 未定義のオプション
    expect(hex(t.sentFlat)).toBe("fffe2c"); // DONT
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

describe("NEW-ENVIRON（IBM i 向けのコードページ申告）", () => {
  it("**IBM i は NEW-ENVIRON を送ってくるので断らない**", () => {
    // 素の 3270 ホスト（Hercules）は送ってこないが、IBM i は 5250 と同じ telnet サーバーを使う。
    // 断るとコードページを申告できず、variant 文字（'@' 等）が化けて CPF1120 になる
    const t = new MockTransport();
    new TelnetLayer(t, { terminalType: "IBM-3279-2-E" });
    t.recv(IAC, CMD.DO, OPT.NEW_ENVIRON);
    expect(hex(t.sentFlat)).toBe("fffb27"); // WILL NEW-ENVIRON（WONT ではない）
  });

  it("SEND に対して KBDTYPE / CODEPAGE / CHARSET を返す", () => {
    const t = new MockTransport();
    new TelnetLayer(t, {
      terminalType: "IBM-3279-2-E",
      kbdType: "USB",
      codePage: 37,
      charSet: 697
    });
    t.recv(IAC, CMD.DO, OPT.NEW_ENVIRON);
    t.sent = [];
    t.recv(IAC, CMD.SB, OPT.NEW_ENVIRON, ENV_SEND, IAC, CMD.SE);
    const sent = t.sentFlat;
    expect(sent[0]).toBe(IAC);
    expect(sent[1]).toBe(CMD.SB);
    expect(sent[2]).toBe(OPT.NEW_ENVIRON);
    expect(sent[3]).toBe(ENV_IS);
    const text = String.fromCharCode(...sent.filter((b) => b >= 0x20 && b < 0x7f));
    expect(text).toContain("KBDTYPE");
    expect(text).toContain("USB");
    expect(text).toContain("CODEPAGE");
    expect(text).toContain("37");
    expect(text).toContain("CHARSET");
    expect(text).toContain("697");
    expect(sent.slice(-2)).toEqual([IAC, CMD.SE]);
  });

  it("申告する値が無ければ空の IS を返す（断らない）", () => {
    const t = new MockTransport();
    new TelnetLayer(t, { terminalType: "X" });
    t.recv(IAC, CMD.DO, OPT.NEW_ENVIRON);
    t.sent = [];
    t.recv(IAC, CMD.SB, OPT.NEW_ENVIRON, ENV_SEND, IAC, CMD.SE);
    expect(hex(t.sentFlat)).toBe("fffa2700fff0"); // SB NEW-ENVIRON IS SE
  });

  /**
   * **装置名は `DEVNAME` で渡す**（RFC 4777）。
   *
   * 実測（pub400）: `DEVNAME=TSTDEV01` を送ると画面の Display name が **TSTDEV01** になる。
   * 端末タイプに `@名前` を付ける方は**交渉が時間切れ**になる（pub400 / 社内機の 2 台で同じ）。
   *
   * ⚠ 受け入れるかは**ホストの設定次第**。社内機は同じ要求で画面を送らずに閉じる。
   */
  it("装置名は NEW-ENVIRON の `DEVNAME` で申告する", () => {
    const t = new MockTransport();
    new TelnetLayer(t, { terminalType: "X", deviceName: "MYDEV01" });
    t.recv(IAC, CMD.DO, OPT.NEW_ENVIRON);
    t.sent = [];
    t.recv(IAC, CMD.SB, OPT.NEW_ENVIRON, ENV_SEND, IAC, CMD.SE);
    const text = String.fromCharCode(...t.sentFlat.filter((b) => b >= 0x20 && b < 0x7f));
    expect(text).toContain("DEVNAME");
    expect(text).toContain("MYDEV01");
  });
});

describe("TN3270E の受理と後退（RFC 2355）", () => {
  const CMD3270E = { DEVICE_TYPE: 0x02, FUNCTIONS: 0x03, IS: 0x04, REQUEST: 0x07, SEND: 0x08 };
  const asc = (s: string): number[] => [...s].map((c) => c.charCodeAt(0));

  /** DO TN3270E → …→ ready まで進める */
  function negotiateE(t: MockTransport, telnet: TelnetLayer): void {
    t.recv(IAC, CMD.DO, OPT.TN3270E);
    t.recv(IAC, CMD.SB, OPT.TN3270E, CMD3270E.SEND, CMD3270E.DEVICE_TYPE, IAC, CMD.SE);
    t.recv(IAC, CMD.SB, OPT.TN3270E, CMD3270E.DEVICE_TYPE, CMD3270E.IS,
      ...asc("IBM-3278-2-E"), 0x01, ...asc("TERM7"), IAC, CMD.SE);
    t.recv(IAC, CMD.SB, OPT.TN3270E, CMD3270E.FUNCTIONS, CMD3270E.IS, IAC, CMD.SE);
    t.recv(IAC, CMD.DO, OPT.END_OF_RECORD, IAC, CMD.WILL, OPT.END_OF_RECORD);
    t.recv(IAC, CMD.DO, OPT.BINARY, IAC, CMD.WILL, OPT.BINARY);
    void telnet;
  }

  it("device-type があれば DO TN3270E に WILL で応じる", () => {
    const t = new MockTransport();
    new TelnetLayer(t, { terminalType: "IBM-3279-2-E", deviceType: "IBM-3278-2-E" });
    t.recv(IAC, CMD.DO, OPT.TN3270E);
    expect(hex(t.sentFlat)).toBe("fffb28");
  });

  it("**device-type が無ければ断る**（基本 TN3270 のまま）", () => {
    const t = new MockTransport();
    new TelnetLayer(t, { terminalType: "IBM-3279-2-E" });
    t.recv(IAC, CMD.DO, OPT.TN3270E);
    expect(hex(t.sentFlat)).toBe("fffc28"); // WONT
  });

  it("**tn3270e:false なら断って基本へ後退する**", () => {
    const t = new MockTransport();
    new TelnetLayer(t, {
      terminalType: "IBM-3279-2-E", deviceType: "IBM-3278-2-E", tn3270e: false
    });
    t.recv(IAC, CMD.DO, OPT.TN3270E);
    expect(hex(t.sentFlat)).toBe("fffc28");
  });

  it("交渉が完了すると isTn3270e と deviceName が立つ", () => {
    const t = new MockTransport();
    const telnet = new TelnetLayer(t, {
      terminalType: "IBM-3279-2-E", deviceType: "IBM-3278-2-E"
    });
    let negotiated = false;
    telnet.onNegotiated(() => (negotiated = true));
    negotiateE(t, telnet);
    expect(telnet.isTn3270e).toBe(true);
    expect(telnet.deviceName).toBe("TERM7");
    expect(negotiated).toBe(true);
  });

  it("**BINARY/EOR だけでは発火しない**——TN3270E が ready になるまで待つ", () => {
    const t = new MockTransport();
    const telnet = new TelnetLayer(t, {
      terminalType: "IBM-3279-2-E", deviceType: "IBM-3278-2-E"
    });
    let negotiated = false;
    telnet.onNegotiated(() => (negotiated = true));
    t.recv(IAC, CMD.DO, OPT.TN3270E);
    t.recv(IAC, CMD.DO, OPT.END_OF_RECORD, IAC, CMD.WILL, OPT.END_OF_RECORD);
    t.recv(IAC, CMD.DO, OPT.BINARY, IAC, CMD.WILL, OPT.BINARY);
    expect(negotiated).toBe(false); // 交渉が終わっていない
    t.recv(IAC, CMD.SB, OPT.TN3270E, CMD3270E.SEND, CMD3270E.DEVICE_TYPE, IAC, CMD.SE);
    t.recv(IAC, CMD.SB, OPT.TN3270E, CMD3270E.DEVICE_TYPE, CMD3270E.IS, ...asc("IBM-3278-2-E"), IAC, CMD.SE);
    t.recv(IAC, CMD.SB, OPT.TN3270E, CMD3270E.FUNCTIONS, CMD3270E.IS, IAC, CMD.SE);
    expect(negotiated).toBe(true);
  });

  it("**送信に 5 バイトヘッダが付く**", () => {
    const t = new MockTransport();
    const telnet = new TelnetLayer(t, {
      terminalType: "IBM-3279-2-E", deviceType: "IBM-3278-2-E"
    });
    negotiateE(t, telnet);
    t.sent = [];
    telnet.sendRecord(Uint8Array.from([0x7d, 0x40, 0x40]));
    expect(hex(t.sentFlat)).toBe("00000000007d4040ffef");
  });

  it("**受信の 5 バイトヘッダが剥がれ、3270-DATA だけが上位へ渡る**", () => {
    const t = new MockTransport();
    const telnet = new TelnetLayer(t, {
      terminalType: "IBM-3279-2-E", deviceType: "IBM-3278-2-E"
    });
    const got: string[] = [];
    telnet.onRecord((r) => got.push(hex([...r])));
    negotiateE(t, telnet);

    t.recv(0x00, 0x00, 0x00, 0x00, 0x00, 0xf5, 0xc3, IAC, CMD.EOR);   // 3270-DATA
    t.recv(0x05, 0x00, 0x00, 0x00, 0x00, 0xc1, IAC, CMD.EOR);         // NVT-DATA → 読み飛ばす
    t.recv(0x7f, 0x00, 0x00, 0x00, 0x00, 0xc2, IAC, CMD.EOR);         // 未知 → 読み飛ばす
    t.recv(0x00, 0x00, IAC, CMD.EOR);                                  // 5 バイト未満 → 読み飛ばす
    expect(got).toEqual(["f5c3"]);
  });

  it("基本 TN3270 ではヘッダを付けない（退行しないこと）", () => {
    const t = new MockTransport();
    const telnet = new TelnetLayer(t, { terminalType: "IBM-3279-2-E" });
    const got: string[] = [];
    telnet.onRecord((r) => got.push(hex([...r])));
    t.recv(IAC, CMD.DO, OPT.END_OF_RECORD, IAC, CMD.WILL, OPT.END_OF_RECORD);
    t.recv(IAC, CMD.DO, OPT.BINARY, IAC, CMD.WILL, OPT.BINARY);
    t.sent = [];
    telnet.sendRecord(Uint8Array.from([0x7d, 0x40, 0x40]));
    expect(hex(t.sentFlat)).toBe("7d4040ffef");
    t.recv(0xf5, 0xc3, IAC, CMD.EOR);
    expect(got).toEqual(["f5c3"]);
  });

  it("**`@装置名` は基本経路でだけ付く**（TN3270E は CONNECT で渡すため）", () => {
    // 基本経路
    const t1 = new MockTransport();
    new TelnetLayer(t1, { terminalType: "IBM-3279-2-E", deviceName: "MYLU" });
    t1.recv(IAC, CMD.DO, OPT.TERMINAL_TYPE);
    t1.sent = [];
    t1.recv(IAC, CMD.SB, OPT.TERMINAL_TYPE, TT_SEND, IAC, CMD.SE);
    expect(String.fromCharCode(...t1.sentFlat.filter((b) => b >= 0x20 && b < 0x7f))).toContain("@MYLU");

    // TN3270E 経路では付かない
    const t2 = new MockTransport();
    new TelnetLayer(t2, {
      terminalType: "IBM-3279-2-E", deviceType: "IBM-3278-2-E", deviceName: "MYLU"
    });
    t2.recv(IAC, CMD.DO, OPT.TN3270E);
    t2.sent = [];
    t2.recv(IAC, CMD.SB, OPT.TERMINAL_TYPE, TT_SEND, IAC, CMD.SE);
    expect(String.fromCharCode(...t2.sentFlat.filter((b) => b >= 0x20 && b < 0x7f))).not.toContain("@MYLU");
  });

  it("REJECT を受けると理由が残る", () => {
    const t = new MockTransport();
    const telnet = new TelnetLayer(t, {
      terminalType: "IBM-3279-2-E", deviceType: "IBM-3278-2-E", deviceName: "TAKEN"
    });
    t.recv(IAC, CMD.DO, OPT.TN3270E);
    t.recv(IAC, CMD.SB, OPT.TN3270E, CMD3270E.SEND, CMD3270E.DEVICE_TYPE, IAC, CMD.SE);
    t.recv(IAC, CMD.SB, OPT.TN3270E, CMD3270E.DEVICE_TYPE, 0x06, 0x05, 0x01, IAC, CMD.SE);
    expect(telnet.isTn3270e).toBe(false);
    expect(telnet.tn3270eError).toMatch(/DEVICE-IN-USE/);
  });
});
