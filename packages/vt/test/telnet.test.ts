import { describe, it, expect } from "vitest";
import { VtTelnet } from "../src/telnet/telnet.js";
import { CMD, IAC, OPT } from "../src/telnet/constants.js";
import { FakeTransport } from "./fake-transport.js";
import { deviceEnvFor } from "@ts5250/base";

const mk = (opts = {}): { t: VtTelnet; io: FakeTransport } => {
  const io = new FakeTransport();
  return { t: new VtTelnet(io, opts), io };
};
const seq = (...n: number[]): number[] => n;

describe("基本の交渉", () => {
  it("`DO TERMINAL-TYPE` に WILL を返し、SEND に名前を返す", () => {
    const { t, io } = mk();
    t.receive(Uint8Array.from([IAC, CMD.DO, OPT.TERMINAL_TYPE]));
    expect(io.take()).toEqual(seq(IAC, CMD.WILL, OPT.TERMINAL_TYPE));
    t.receive(Uint8Array.from([IAC, CMD.SB, OPT.TERMINAL_TYPE, 1, IAC, CMD.SE]));
    expect(io.takeText()).toContain("xterm-256color");
  });

  it("**候補を順に出し、尽きたら同じ名前を繰り返す**（これが「もう無い」の合図）", () => {
    const { t, io } = mk({ terminalTypes: ["A", "B"] });
    t.receive(Uint8Array.from([IAC, CMD.DO, OPT.TERMINAL_TYPE]));
    io.take();
    const ask = (): string => {
      t.receive(Uint8Array.from([IAC, CMD.SB, OPT.TERMINAL_TYPE, 1, IAC, CMD.SE]));
      return io.takeText();
    };
    expect(ask()).toContain("A");
    expect(ask()).toContain("B");
    expect(ask()).toContain("B");
  });

  it("**IBM i には VT220 だけを申告できる**（research 1.1）", () => {
    const { t, io } = mk({ terminalTypes: ["VT220"] });
    t.receive(Uint8Array.from([IAC, CMD.DO, OPT.TERMINAL_TYPE]));
    io.take();
    t.receive(Uint8Array.from([IAC, CMD.SB, OPT.TERMINAL_TYPE, 1, IAC, CMD.SE]));
    expect(io.takeText()).toContain("VT220");
    expect(t.terminalType).toBe("VT220");
  });

  it("**`WILL ECHO` に DO を返す＝文字モードの成立**", () => {
    const { t, io } = mk();
    expect(t.hostEchoes).toBe(false);
    t.receive(Uint8Array.from([IAC, CMD.WILL, OPT.ECHO, IAC, CMD.WILL, OPT.SGA]));
    expect(io.take()).toEqual(seq(IAC, CMD.DO, OPT.ECHO, IAC, CMD.DO, OPT.SGA));
    expect(t.hostEchoes).toBe(true);
  });

  it("知らないオプションは断る", () => {
    const { t, io } = mk();
    t.receive(Uint8Array.from([IAC, CMD.DO, OPT.XDISPLOC]));
    expect(io.take()).toEqual(seq(IAC, CMD.WONT, OPT.XDISPLOC));
    t.receive(Uint8Array.from([IAC, CMD.WILL, OPT.STATUS]));
    expect(io.take()).toEqual(seq(IAC, CMD.DONT, OPT.STATUS));
  });
});

describe("NAWS", () => {
  it("握った直後に必ず 1 度送る（`stty size` がこれで決まる）", () => {
    const { t, io } = mk({ rows: 40, cols: 132 });
    t.receive(Uint8Array.from([IAC, CMD.DO, OPT.NAWS]));
    expect(io.take()).toEqual(
      seq(IAC, CMD.WILL, OPT.NAWS, IAC, CMD.SB, OPT.NAWS, 0, 132, 0, 40, IAC, CMD.SE)
    );
  });

  it("大きさが変わったら再送する", () => {
    const { t, io } = mk();
    t.receive(Uint8Array.from([IAC, CMD.DO, OPT.NAWS]));
    io.take();
    t.setWindowSize(50, 100);
    expect(io.take()).toEqual(seq(IAC, CMD.SB, OPT.NAWS, 0, 100, 0, 50, IAC, CMD.SE));
  });

  it("握っていなければ送らない（勝手に喋らない）", () => {
    const { t, io } = mk();
    t.setWindowSize(50, 100);
    expect(io.take()).toEqual([]);
  });
});

describe("NEW-ENVIRON（IBM i）", () => {
  it("**`DO NEW-ENVIRON` が IBM i の見分け**", () => {
    const { t } = mk();
    expect(t.isIbmI).toBe(false);
    t.receive(Uint8Array.from([IAC, CMD.DO, OPT.NEW_ENVIRON]));
    expect(t.isIbmI).toBe(true);
  });

  it("**KBDTYPE / CODEPAGE / CHARSET を申告する**（CPF1120 の解消。research 1.3）", () => {
    const { t, io } = mk({ deviceEnv: deviceEnvFor(37) });
    t.receive(Uint8Array.from([IAC, CMD.DO, OPT.NEW_ENVIRON]));
    io.take();
    t.receive(Uint8Array.from([IAC, CMD.SB, OPT.NEW_ENVIRON, 1, IAC, CMD.SE]));
    const text = io.takeText();
    expect(text).toContain("KBDTYPE");
    expect(text).toContain("USB");
    expect(text).toContain("CODEPAGE");
    expect(text).toContain("37");
    expect(text).toContain("CHARSET");
    expect(text).toContain("697");
  });

  it("装置名も渡せる（RFC 4777 の DEVNAME）", () => {
    const { t, io } = mk({ deviceName: "TSTDEV01" });
    t.receive(Uint8Array.from([IAC, CMD.DO, OPT.NEW_ENVIRON]));
    io.take();
    t.receive(Uint8Array.from([IAC, CMD.SB, OPT.NEW_ENVIRON, 1, IAC, CMD.SE]));
    expect(io.takeText()).toContain("DEVNAME");
  });

  it("申告するものが無ければ空の IS を返す（黙り込まない）", () => {
    const { t, io } = mk();
    t.receive(Uint8Array.from([IAC, CMD.DO, OPT.NEW_ENVIRON]));
    io.take();
    t.receive(Uint8Array.from([IAC, CMD.SB, OPT.NEW_ENVIRON, 1, IAC, CMD.SE]));
    expect(io.take()).toEqual(seq(IAC, CMD.SB, OPT.NEW_ENVIRON, 0, IAC, CMD.SE));
  });
});

describe("データの取り出し", () => {
  it("交渉を抜いてアプリのデータだけ返す", () => {
    const { t } = mk();
    const out = t.receive(Uint8Array.from([
      0x41, IAC, CMD.WILL, OPT.SGA, 0x42, IAC, CMD.DO, OPT.NAWS, 0x43
    ]));
    expect([...out]).toEqual([0x41, 0x42, 0x43]);
  });

  it("**`IAC IAC` は 1 つの 0xFF に戻す**", () => {
    const { t } = mk();
    expect([...t.receive(Uint8Array.from([0x41, IAC, IAC, 0x42]))]).toEqual([0x41, 0xff, 0x42]);
  });

  it("**交渉の途中で切れても壊れない**（続きを待つ）", () => {
    const { t, io } = mk();
    expect([...t.receive(Uint8Array.from([0x41, IAC]))]).toEqual([0x41]);
    expect([...t.receive(Uint8Array.from([CMD.WILL]))]).toEqual([]);
    expect([...t.receive(Uint8Array.from([OPT.ECHO, 0x42]))]).toEqual([0x42]);
    expect(io.take()).toEqual(seq(IAC, CMD.DO, OPT.ECHO));
  });

  it("サブネゴシエーションが途中で切れても待つ", () => {
    const { t, io } = mk({ terminalTypes: ["X"] });
    t.receive(Uint8Array.from([IAC, CMD.DO, OPT.TERMINAL_TYPE]));
    io.take();
    t.receive(Uint8Array.from([IAC, CMD.SB, OPT.TERMINAL_TYPE]));
    expect(io.take()).toEqual([]);
    t.receive(Uint8Array.from([1, IAC, CMD.SE]));
    expect(io.takeText()).toContain("X");
  });

  it("単独コマンド（NOP / GA）は読み飛ばす", () => {
    const { t } = mk();
    expect([...t.receive(Uint8Array.from([0x41, IAC, CMD.NOP, IAC, CMD.GA, 0x42]))])
      .toEqual([0x41, 0x42]);
  });
});

describe("送信", () => {
  it("**0xFF は IAC IAC に脱出する**（日本語を 8 ビットで送ると必ず出る）", () => {
    const { t, io } = mk();
    t.sendData(Uint8Array.from([0x41, 0xff, 0x42]));
    expect(io.take()).toEqual([0x41, IAC, IAC, 0x42]);
  });

  it("0xFF が無ければそのまま", () => {
    const { t, io } = mk();
    t.sendData(Uint8Array.from([0x41, 0x42]));
    expect(io.take()).toEqual([0x41, 0x42]);
  });
});

describe("BINARY", () => {
  it("既定では双方向で合意する", () => {
    const { t, io } = mk();
    t.receive(Uint8Array.from([IAC, CMD.WILL, OPT.BINARY, IAC, CMD.DO, OPT.BINARY]));
    expect(io.take()).toEqual(seq(IAC, CMD.DO, OPT.BINARY, IAC, CMD.WILL, OPT.BINARY));
    expect(t.negotiatedBinary).toBe(true);
  });

  it("切っておけば断る", () => {
    const { t, io } = mk({ binary: false });
    t.receive(Uint8Array.from([IAC, CMD.DO, OPT.BINARY]));
    expect(io.take()).toEqual(seq(IAC, CMD.WONT, OPT.BINARY));
  });
});

describe("実機で起きた並び（research 1.1 / 2）", () => {
  it("IBM i の順序をそのまま流す", () => {
    const { t, io } = mk({ terminalTypes: ["VT220"], deviceEnv: deviceEnvFor(37) });
    t.receive(Uint8Array.from([IAC, CMD.DO, OPT.NEW_ENVIRON]));
    t.receive(Uint8Array.from([IAC, CMD.DO, OPT.TERMINAL_TYPE]));
    t.receive(Uint8Array.from([IAC, CMD.SB, OPT.TERMINAL_TYPE, 1, IAC, CMD.SE]));
    t.receive(Uint8Array.from([IAC, CMD.WILL, OPT.ECHO]));
    t.receive(Uint8Array.from([IAC, CMD.WILL, OPT.SGA]));
    const text = io.takeText();
    expect(text).toContain("VT220");
    expect(t.isIbmI).toBe(true);
    expect(t.hostEchoes).toBe(true);
  });

  it("Linux の telnetd の順序（`DO ECHO` を断る）", () => {
    const { t, io } = mk();
    // busybox telnetd は DO ECHO を出す。**こちらはエコーを持たない**ので断る
    t.receive(Uint8Array.from([IAC, CMD.DO, OPT.ECHO]));
    expect(io.take()).toEqual(seq(IAC, CMD.WONT, OPT.ECHO));
    t.receive(Uint8Array.from([IAC, CMD.DO, OPT.NAWS]));
    expect(io.take().slice(0, 3)).toEqual(seq(IAC, CMD.WILL, OPT.NAWS));
  });
});
