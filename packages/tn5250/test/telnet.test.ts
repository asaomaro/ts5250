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
      ENV_USERVAR, ...ascii("IBMSENDCONFREC"), ENV_VALUE, ...ascii("YES"),
      IAC, CMD.SE
    ]);
  });

  it("デバイス名未設定なら NEW-ENVIRON は空 IS", () => {
    const { t } = setup();
    t.feed(IAC, CMD.SB, OPT.NEW_ENVIRON, ENV_SEND, IAC, CMD.SE);
    expect(t.takeSent()).toEqual([
      IAC, CMD.SB, OPT.NEW_ENVIRON, ENV_IS,
      ENV_USERVAR, ...ascii("IBMSENDCONFREC"), ENV_VALUE, ...ascii("YES"),
      IAC, CMD.SE
    ]);
  });

  // ~~IBMRSEED(ゼロシード)~~ → ACS と同じく平文では値なし（`20260921-telnet-signon-vars`。以前は ESC＋8 バイトの 0 で、
  // エスケープされない 7 個の 0x00 が空の VAR として読まれていた）
  it("RFC 4777 自動サインオン: USER + IBMRSEED(値なし) + IBMSUBSPW(平文)", () => {
    const { t } = setupAuto({ deviceName: "WEBEMU01", user: "MYUSER", password: "SECRET" });
    t.feed(IAC, CMD.SB, OPT.NEW_ENVIRON, ENV_SEND, IAC, CMD.SE);
    const ENV_VAR = 0;
    expect(t.takeSent()).toEqual([
      IAC, CMD.SB, OPT.NEW_ENVIRON, ENV_IS,
      ENV_USERVAR, ...ascii("DEVNAME"), ENV_VALUE, ...ascii("WEBEMU01"),
      ENV_USERVAR, ...ascii("IBMSENDCONFREC"), ENV_VALUE, ...ascii("YES"),
      ENV_VAR, ...ascii("USER"), ENV_VALUE, ...ascii("MYUSER"),
      ENV_USERVAR, ...ascii("IBMRSEED"), ENV_VALUE,
      ENV_USERVAR, ...ascii("IBMSUBSPW"), ENV_VALUE, ...ascii("SECRET"),
      IAC, CMD.SE
    ]);
  });

  it("利用者名は前後の空白を落として大文字、パスワードは末尾の空白を落とす（ACS と同じ正規化）", () => {
    const { t } = setupAuto({ user: " myuser ", password: "Secret  " });
    t.feed(IAC, CMD.SB, OPT.NEW_ENVIRON, ENV_SEND, IAC, CMD.SE);
    const sent = t.takeSent();
    const text = String.fromCharCode(...sent);
    expect(text).toContain("USER\x01MYUSER");
    expect(text).toContain("IBMSUBSPW\x01Secret\xff");
  });

  it("**利用者名は Java の `trim()` と同じ**——前後の U+0020 以下（制御文字を含む）だけを落とし、全角空白は残す", () => {
    const { t } = setupAuto({ user: "\u0001\tmyuser\u0000 ", password: "S" });
    t.feed(IAC, CMD.SB, OPT.NEW_ENVIRON, ENV_SEND, IAC, CMD.SE);
    const text = String.fromCharCode(...t.takeSent());
    expect(text).toContain("USER\x01MYUSER\x03"); // 次の USERVAR（3）が直後に続く＝前後に何も残っていない
  });

  it("**ACS と同じく、利用者名が 10 文字・パスワードが 128 文字を超えるか空なら自動サインオンをやめる**（USER も送らない）", () => {
    for (const [user, password] of [
      ["ABCDEFGHIJK", "S"],
      ["U", "x".repeat(129)],
      ["   ", "S"],
      ["U", ""],
      ["U", "   "] // 空白だけのパスワードも空（ACS は末尾の空白を落としてから見る）
    ] as const) {
      const { t } = setupAuto({ user, password });
      t.feed(IAC, CMD.SB, OPT.NEW_ENVIRON, ENV_SEND, IAC, CMD.SE);
      const text = String.fromCharCode(...t.takeSent());
      expect(text, `${user.length}/${password.length}`).not.toContain("USER\x01");
      expect(text).not.toContain("IBMSUBSPW");
    }
    // ちょうど 10 文字・128 文字は送る
    const { t } = setupAuto({ user: "ABCDEFGHIJ", password: "x".repeat(128) });
    t.feed(IAC, CMD.SB, OPT.NEW_ENVIRON, ENV_SEND, IAC, CMD.SE);
    expect(String.fromCharCode(...t.takeSent())).toContain("IBMSUBSPW");
  });

  /**
   * **暗号化した自動サインオン**（ACS と同じく平文で送らない。`20260921-encrypted-autosignon`）。
   * 実測（ACS のコア・PUB400・QPWDLVL 3）: ホストの SEND は `USERVAR IBMRSEED <シード 8 バイト>`、ACS の IS は IBMRSEED に自分のシード、
   * IBMSUBSPW に 20 バイトの代替パスワードを入れ、サインオン画面を飛ばしてメニューまで進んだ。
   */
  describe("暗号化した自動サインオン", () => {
    const serverSeed = [0x01, 0x02, 0xff, 0x10, 0x20, 0x30, 0x40, 0x50];
    // SEND: USERVAR IBMRSEED <seed>（0xFF は telnet の層で二重） VAR USERVAR
    const sendWithSeed = [IAC, CMD.SB, OPT.NEW_ENVIRON, ENV_SEND, ENV_USERVAR, ...ascii("IBMRSEED"), 0x01, 0x02, 0xff, 0xff, 0x10, 0x20, 0x30, 0x40, 0x50, 0, ENV_USERVAR, IAC, CMD.SE];
    const flush = () => new Promise((r) => setTimeout(r, 0));
    function setupEnc(sub: (seed: Uint8Array) => Promise<{ clientSeed: Uint8Array; substitute: Uint8Array }>) {
      const t = new FakeTransport();
      new TelnetLayer(t, { terminalType: "IBM-3179-2", user: "u", password: "pw", passwordSubstitute: sub });
      return t;
    }

    it("**ホストのシードで代替パスワードを作り、IBMRSEED に自分のシード・IBMSUBSPW に代替パスワード**（平文は送らない）", async () => {
      const seen: number[][] = [];
      const t = setupEnc(async (seed) => {
        seen.push([...seed]);
        return { clientSeed: Uint8Array.from([9, 8, 7, 6, 5, 4, 3, 0]), substitute: Uint8Array.from([0xaa, 0x01, 0xff, 0xbb]) };
      });
      t.feed(...sendWithSeed);
      await flush();
      expect(seen).toEqual([serverSeed]);
      const sent = t.takeSent();
      const text = String.fromCharCode(...sent);
      expect(text).toContain("USER\x01U");
      // 値の 0x00〜0x03 は ESC（2）、0xFF は IAC の二重化
      expect(text).toContain("IBMRSEED\x01\x09\x08\x07\x06\x05\x04\x02\x03\x02\x00");
      expect(text).toContain("IBMSUBSPW\x01\xaa\x02\x01\xff\xff\xbb");
      expect(text).not.toContain("pw");
    });

    it("**IS を送るまで後続の交渉に答えない**（平文のときと同じ順序。IS が交渉の後に届くとホストはサインオン画面を出した——実測）", async () => {
      let release!: () => void;
      const t = setupEnc(
        () =>
          new Promise((r) => {
            release = () => r({ clientSeed: new Uint8Array(8), substitute: new Uint8Array(20) });
          })
      );
      // 実機と同じく、NEW-ENVIRON SEND と TERMINAL-TYPE SEND が続けて届く
      t.feed(...sendWithSeed, IAC, CMD.SB, OPT.TERMINAL_TYPE, TT_SEND, IAC, CMD.SE);
      await flush();
      expect(t.takeSent(), "IS より先に端末タイプへ答えた").toEqual([]);
      release();
      await flush();
      const sent = t.takeSent();
      const env = String.fromCharCode(...sent).indexOf("IBMSUBSPW");
      const tt = String.fromCharCode(...sent).indexOf("IBM-3179-2");
      expect(env).toBeGreaterThan(-1);
      expect(tt).toBeGreaterThan(env);
    });

    // ~~パスワードの変数を送らない（ACS も書かない）~~ → ACS は IBMRSEED に自分のシード、IBMSUBSPW を値の無いまま送る（節目の点検の指摘）
    it("シードが無い・計算に失敗したら**IBMSUBSPW は値の無いまま**（平文には落とさない。ACS と同じ）", async () => {
      const t1 = setupEnc(async () => ({ clientSeed: new Uint8Array(8), substitute: new Uint8Array(20) }));
      t1.feed(IAC, CMD.SB, OPT.NEW_ENVIRON, ENV_SEND, IAC, CMD.SE);
      await flush();
      const a = String.fromCharCode(...t1.takeSent());
      expect(a).toContain("USER\x01U");
      expect(a).toMatch(/IBMSUBSPW\x01(\xff\xf0|$)/); // 値が無い（IAC SE が続く）
      expect(a).toMatch(/IBMRSEED\x01[\s\S]/); // 自分のシード（乱数。先頭が 0x0A・0x0D のこともあるので `.` では取りこぼす）
      expect(a).not.toContain("pw");
      const t2 = setupEnc(async () => {
        throw new Error("x");
      });
      t2.feed(...sendWithSeed);
      await flush();
      const b = String.fromCharCode(...t2.takeSent());
      expect(b).toContain("USER\x01U");
      expect(b).toMatch(/IBMSUBSPW\x01(\xff\xf0|$)/);
      expect(b).not.toContain("pw");
    });
  });

  it("値の 0x00〜0x03 は ESC でエスケープする（RFC 1572。ACS も同じ）", () => {
    const { t } = setupAuto({ user: "U", password: "a\u0001b" });
    t.feed(IAC, CMD.SB, OPT.NEW_ENVIRON, ENV_SEND, IAC, CMD.SE);
    const sent = t.takeSent();
    const at = sent.indexOf(0x61);
    expect(sent.slice(at, at + 4)).toEqual([0x61, 2, 1, 0x62]);
  });

  // ~~password 未指定（user のみ）なら USER だけ送る~~ → ACS と同じく USER も送らない（`NVT5250.insertUser` は自動サインオンのときだけ。
  // `20260921-user-without-password`）
  it("password 未指定（user のみ）なら USER も IBMRSEED/IBMSUBSPW も送らない", () => {
    const { t } = setupAuto({ user: "MYUSER" });
    t.feed(IAC, CMD.SB, OPT.NEW_ENVIRON, ENV_SEND, IAC, CMD.SE);
    expect(t.takeSent()).toEqual([
      IAC, CMD.SB, OPT.NEW_ENVIRON, ENV_IS,
      ENV_USERVAR, ...ascii("IBMSENDCONFREC"), ENV_VALUE, ...ascii("YES"),
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
      ENV_USERVAR, ...ascii("IBMSENDCONFREC"), ENV_VALUE, ...ascii("YES"),
      IAC, CMD.SE
    ]);
  });

  it("未指定なら申告しない（後方互換）", () => {
    const t = new FakeTransport();
    const telnet = new TelnetLayer(t, { terminalType: "IBM-3179-2" });
    void telnet;
    t.feed(IAC, CMD.SB, OPT.NEW_ENVIRON, ENV_SEND, IAC, CMD.SE);
    expect(t.takeSent()).toEqual([
      IAC, CMD.SB, OPT.NEW_ENVIRON, ENV_IS,
      ENV_USERVAR, ...ascii("IBMSENDCONFREC"), ENV_VALUE, ...ascii("YES"),
      IAC, CMD.SE
    ]);
  });
});
