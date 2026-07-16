import { describe, it, expect } from "vitest";
import { TelnetLayer } from "../src/telnet/telnet.js";
import { IAC, CMD, OPT, TT_IS, TT_SEND, ENV_IS, ENV_SEND, ENV_USERVAR, ENV_VALUE } from "../src/telnet/constants.js";
import { FakeTransport } from "./helpers/fake-transport.js";

function ascii(s: string): number[] {
  return [...s].map((c) => c.charCodeAt(0));
}

function setup(deviceName?: string) {
  const t = new FakeTransport();
  const telnet = new TelnetLayer(t, { terminalType: "IBM-3179-2", deviceName });
  const records: Uint8Array[] = [];
  telnet.onRecord((r) => records.push(r));
  return { t, telnet, records };
}

function setupAuto(opts: { deviceName?: string; user?: string; password?: string }) {
  const t = new FakeTransport();
  const telnet = new TelnetLayer(t, { terminalType: "IBM-3179-2", ...opts });
  return { t, telnet };
}

describe("TelnetLayer ネゴシエーション", () => {
  it("DO(対応オプション) に WILL、DO(未対応) に WONT を返す", () => {
    const { t } = setup();
    t.feed(IAC, CMD.DO, OPT.TERMINAL_TYPE);
    expect(t.takeSent()).toEqual([IAC, CMD.WILL, OPT.TERMINAL_TYPE]);
    t.feed(IAC, CMD.DO, 99);
    expect(t.takeSent()).toEqual([IAC, CMD.WONT, 99]);
  });

  it("WILL(対応) に DO、WILL(未対応) に DONT を返す", () => {
    const { t } = setup();
    t.feed(IAC, CMD.WILL, OPT.EOR);
    expect(t.takeSent()).toEqual([IAC, CMD.DO, OPT.EOR]);
    t.feed(IAC, CMD.WILL, 99);
    expect(t.takeSent()).toEqual([IAC, CMD.DONT, 99]);
  });

  it("TERMINAL-TYPE SEND に IS + 端末タイプ名で応答する", () => {
    const { t } = setup();
    t.feed(IAC, CMD.SB, OPT.TERMINAL_TYPE, TT_SEND, IAC, CMD.SE);
    expect(t.takeSent()).toEqual([
      IAC, CMD.SB, OPT.TERMINAL_TYPE, TT_IS, ...ascii("IBM-3179-2"), IAC, CMD.SE
    ]);
  });

  it("NEW-ENVIRON SEND に DEVNAME を USERVAR で応答する", () => {
    const { t } = setup("WEBEMU01");
    t.feed(IAC, CMD.SB, OPT.NEW_ENVIRON, ENV_SEND, IAC, CMD.SE);
    expect(t.takeSent()).toEqual([
      IAC, CMD.SB, OPT.NEW_ENVIRON, ENV_IS,
      ENV_USERVAR, ...ascii("DEVNAME"), ENV_VALUE, ...ascii("WEBEMU01"),
      IAC, CMD.SE
    ]);
  });

  it("デバイス名未設定なら NEW-ENVIRON は空 IS", () => {
    const { t } = setup();
    t.feed(IAC, CMD.SB, OPT.NEW_ENVIRON, ENV_SEND, IAC, CMD.SE);
    expect(t.takeSent()).toEqual([IAC, CMD.SB, OPT.NEW_ENVIRON, ENV_IS, IAC, CMD.SE]);
  });

  it("RFC 4777 自動サインオン: USER + IBMRSEED(ゼロシード) + IBMSUBSPW(平文)", () => {
    const { t } = setupAuto({ deviceName: "WEBEMU01", user: "MYUSER", password: "SECRET" });
    t.feed(IAC, CMD.SB, OPT.NEW_ENVIRON, ENV_SEND, IAC, CMD.SE);
    const ENV_VAR = 0, ENV_ESC = 2;
    expect(t.takeSent()).toEqual([
      IAC, CMD.SB, OPT.NEW_ENVIRON, ENV_IS,
      ENV_USERVAR, ...ascii("DEVNAME"), ENV_VALUE, ...ascii("WEBEMU01"),
      ENV_VAR, ...ascii("USER"), ENV_VALUE, ...ascii("MYUSER"),
      ENV_USERVAR, ...ascii("IBMRSEED"), ENV_VALUE, ENV_ESC, 0, 0, 0, 0, 0, 0, 0, 0,
      ENV_USERVAR, ...ascii("IBMSUBSPW"), ENV_VALUE, ...ascii("SECRET"),
      IAC, CMD.SE
    ]);
  });

  it("password 未指定（user のみ）なら IBMRSEED/IBMSUBSPW は送らない", () => {
    const { t } = setupAuto({ user: "MYUSER" });
    t.feed(IAC, CMD.SB, OPT.NEW_ENVIRON, ENV_SEND, IAC, CMD.SE);
    const ENV_VAR = 0;
    expect(t.takeSent()).toEqual([
      IAC, CMD.SB, OPT.NEW_ENVIRON, ENV_IS,
      ENV_VAR, ...ascii("USER"), ENV_VALUE, ...ascii("MYUSER"),
      IAC, CMD.SE
    ]);
  });
});

describe("TelnetLayer レコード枠組み", () => {
  it("IAC EOR で区切られたレコードを切り出す", () => {
    const { t, records } = setup();
    t.feed(1, 2, 3, IAC, CMD.EOR, 4, 5, IAC, CMD.EOR);
    expect(records.map((r) => [...r])).toEqual([
      [1, 2, 3],
      [4, 5]
    ]);
  });

  it("IAC IAC を 0xFF 1 バイトに解除する（ネゴ混在・分割着信でも）", () => {
    const { t, records } = setup();
    t.feed(1, IAC);
    t.feed(IAC, 2); // 分割された IAC IAC
    t.feed(IAC, CMD.DO, OPT.BINARY); // レコード途中のネゴシエーション
    t.feed(IAC, CMD.EOR);
    expect(records.map((r) => [...r])).toEqual([[1, 0xff, 2]]);
    expect(t.takeSent()).toEqual([IAC, CMD.WILL, OPT.BINARY]);
  });

  it("sendRecord は 0xFF をエスケープし IAC EOR を付与する", () => {
    const { t, telnet } = setup();
    telnet.sendRecord(Uint8Array.from([1, 0xff, 2]));
    expect(t.takeSent()).toEqual([1, IAC, IAC, 2, IAC, CMD.EOR]);
  });

  it("SB 内の IAC IAC はデータとして保持し SE で復帰する", () => {
    const { t, records } = setup();
    // 未知のサブネゴシエーション（無視されるが、パースは崩れない）
    t.feed(IAC, CMD.SB, 45, 1, IAC, IAC, 2, IAC, CMD.SE);
    t.feed(9, IAC, CMD.EOR);
    expect(records.map((r) => [...r])).toEqual([[9]]);
  });
});

describe("RFC 2877 デバイス属性の申告（KBDTYPE/CODEPAGE/CHARSET）", () => {
  // 申告しないとホストはシステム既定でデバイスを作り、variant 文字（'@' 等）が食い違う。
  // PUB400（QCCSID=273）実機で、無申告だと '@' 入りパスワードが化けて CPF1120 になり、
  // KBDTYPE を含む 3 点を申告すると 37/273/930/939/1399 いずれでも通ることを確認済み。
  // CODEPAGE/CHARSET だけ（KBDTYPE 無し）では PUB400 は反応しない＝KBDTYPE は必須。
  it("KBDTYPE/CODEPAGE/CHARSET を DEVNAME に続けて USERVAR で送る", () => {
    const t = new FakeTransport();
    const telnet = new TelnetLayer(t, {
      terminalType: "IBM-3179-2",
      deviceName: "WEBEMU01",
      kbdType: "USB",
      codePage: 37,
      charSet: 697
    });
    void telnet;
    t.feed(IAC, CMD.SB, OPT.NEW_ENVIRON, ENV_SEND, IAC, CMD.SE);
    expect(t.takeSent()).toEqual([
      IAC, CMD.SB, OPT.NEW_ENVIRON, ENV_IS,
      ENV_USERVAR, ...ascii("DEVNAME"), ENV_VALUE, ...ascii("WEBEMU01"),
      ENV_USERVAR, ...ascii("KBDTYPE"), ENV_VALUE, ...ascii("USB"),
      ENV_USERVAR, ...ascii("CODEPAGE"), ENV_VALUE, ...ascii("37"),
      ENV_USERVAR, ...ascii("CHARSET"), ENV_VALUE, ...ascii("697"),
      IAC, CMD.SE
    ]);
  });

  it("未指定なら申告しない（後方互換）", () => {
    const t = new FakeTransport();
    const telnet = new TelnetLayer(t, { terminalType: "IBM-3179-2" });
    void telnet;
    t.feed(IAC, CMD.SB, OPT.NEW_ENVIRON, ENV_SEND, IAC, CMD.SE);
    expect(t.takeSent()).toEqual([IAC, CMD.SB, OPT.NEW_ENVIRON, ENV_IS, IAC, CMD.SE]);
  });
});
