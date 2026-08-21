import { describe, it, expect, vi } from "vitest";
import { VtSession } from "../src/session/vt-session.js";
import { CMD, IAC, OPT } from "../src/telnet/constants.js";
import { FakeTransport } from "./fake-transport.js";

const dec = new TextDecoder();

function open(opts: Partial<ConstructorParameters<typeof VtSession>[0]> = {}): {
  s: VtSession;
  io: FakeTransport;
} {
  const io = new FakeTransport();
  const s = new VtSession({ host: "x", writeDelayMs: 0, ...opts });
  s.attach(io);
  io.take(); // 接続直後の送信を捨てる
  return { s, io };
}

const text = (s: VtSession): string[] =>
  s.snapshot().cells.map((r) => r.map((c) => (c.width === 0 ? "" : c.char)).join("").replace(/ +$/u, ""));

describe("受け取って画面にする", () => {
  it("ホストの出力が画面になる", () => {
    const { s, io } = open();
    io.host("hello\r\nworld");
    expect(text(s).slice(0, 2)).toEqual(["hello", "world"]);
  });

  it("**交渉とデータが混ざって来ても分けられる**", () => {
    const { s, io } = open();
    io.host("ab", IAC, CMD.WILL, OPT.ECHO, "cd");
    expect(text(s)[0]).toBe("abcd");
    expect(s.hostEchoes).toBe(true);
  });

  it("画面が変わるたび screen が飛ぶ", () => {
    const { s, io } = open();
    const seen: number[] = [];
    s.on("screen", (snap) => seen.push(snap.cursor.col));
    io.host("abc");
    io.host("de");
    expect(seen).toEqual([3, 5]);
  });

  it("タイトルとベルを伝える", () => {
    const { s, io } = open();
    const titles: string[] = [];
    let bells = 0;
    s.on("title", (t) => titles.push(t));
    s.on("bell", () => bells++);
    io.host("\x1b]0;My Shell\x07\x07");
    expect(titles).toEqual(["My Shell"]);
    expect(bells).toBe(1);
  });

  it("**問われたら答える**（DA / CPR を自動で返す）", () => {
    const { io } = open();
    io.host("\x1b[c");
    expect(io.takeText()).toBe("\x1b[?64;1;2;6;22c");
    io.host("\x1b[3;7H\x1b[6n");
    expect(io.takeText()).toBe("\x1b[3;7R");
  });
});

describe("打鍵を送る", () => {
  it("文字はそのまま", () => {
    const { s, io } = open();
    s.text("ls");
    expect(io.takeText()).toBe("ls");
  });

  it("キーはモードで変わる", () => {
    const { s, io } = open();
    s.key({ key: "ArrowUp" });
    expect(io.takeText()).toBe("\x1b[A");
    io.host("\x1b[?1h"); // DECCKM
    s.key({ key: "ArrowUp" });
    expect(io.takeText()).toBe("\x1bOA");
  });

  it("貼り付けは `?2004` が有効なら包む", () => {
    const { s, io } = open();
    s.paste("ls");
    expect(io.takeText()).toBe("ls");
    io.host("\x1b[?2004h");
    s.paste("ls");
    expect(io.takeText()).toBe("\x1b[200~ls\x1b[201~");
  });

  it("マウスは報告が有効なときだけ送る", () => {
    const { s, io } = open();
    s.mouse({ button: "left", row: 0, col: 0, kind: "down" });
    expect(io.take()).toEqual([]);
    io.host("\x1b[?1000h\x1b[?1006h");
    s.mouse({ button: "left", row: 0, col: 0, kind: "down" });
    expect(io.takeText()).toBe("\x1b[<0;1;1M");
  });

  it("**送れない文字は落として警告する**（黙って消さない）", () => {
    const warns: string[] = [];
    const { s, io } = open({ encoding: "shift_jis", warn: (m) => warns.push(m) });
    s.text("A😀");
    expect(io.take()).toEqual([0x41, 0x3f]);
    expect(warns[0]).toContain("😀");
  });

  it("閉じたあとに送ろうとしたら明示的に落ちる", () => {
    const { s, io } = open();
    io.close();
    expect(() => s.text("x")).toThrow(/閉じ/u);
  });
});

describe("IBM i の間合い（spec D12）", () => {
  it("**IBM i と分かったら 1 文字ずつ間を空けて送る**", async () => {
    vi.useFakeTimers();
    try {
      const io = new FakeTransport();
      const s = new VtSession({ host: "x" }); // writeDelayMs を指定しない＝自動
      s.attach(io);
      io.host(IAC, CMD.DO, OPT.NEW_ENVIRON); // IBM i の見分け
      io.take();
      expect(s.isIbmI).toBe(true);
      s.text("abc");
      // **待ち行列に繋ぐので送信はマイクロタスク以降**（順序を保つための代償）
      expect(io.takeText()).toBe("");
      await vi.advanceTimersByTimeAsync(0);
      expect(io.takeText()).toBe("a");
      await vi.advanceTimersByTimeAsync(20);
      expect(io.takeText()).toBe("b");
      await vi.advanceTimersByTimeAsync(20);
      expect(io.takeText()).toBe("c");
    } finally {
      vi.useRealTimers();
    }
  });

  it("IBM i でなければ一括で送る", () => {
    const io = new FakeTransport();
    const s = new VtSession({ host: "x" });
    s.attach(io);
    io.take();
    s.text("abc");
    expect(io.takeText()).toBe("abc");
  });

  it("**順序が入れ替わらない**（待ちに入っても後続を追い越させない）", async () => {
    vi.useFakeTimers();
    try {
      const io = new FakeTransport();
      const s = new VtSession({ host: "x", writeDelayMs: 5 });
      s.attach(io);
      io.take();
      s.text("ab");
      s.text("cd");
      await vi.advanceTimersByTimeAsync(100);
      expect(io.takeText()).toBe("abcd");
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("大きさ", () => {
  it("resize は画面とホストの両方に伝わる", () => {
    const { s, io } = open({ rows: 24, cols: 80 });
    io.host(IAC, CMD.DO, OPT.NAWS);
    io.take();
    s.resize(30, 100);
    expect(s.snapshot().rows).toBe(30);
    expect(io.take()).toEqual([IAC, CMD.SB, OPT.NAWS, 0, 100, 0, 30, IAC, CMD.SE]);
  });
});

describe("閉じるとき", () => {
  it("理由を伝える", () => {
    const { s, io } = open();
    const reasons: string[] = [];
    s.on("close", (r) => reasons.push(r));
    io.host("x");
    io.close();
    expect(reasons).toEqual(["closed by client"]);
  });

  it("**画面が来ないまま閉じた IBM i には手掛かりを添える**（research 1.2 の SR-OSAKA）", () => {
    const { s, io } = open();
    io.host(IAC, CMD.DO, OPT.NEW_ENVIRON);
    const reasons: string[] = [];
    s.on("close", (r) => reasons.push(r));
    io.close();
    expect(reasons[0]).toContain("CPF1194");
  });

  it("画面が来ていれば余計なことを言わない", () => {
    const { s, io } = open();
    io.host(IAC, CMD.DO, OPT.NEW_ENVIRON);
    io.host("Sign On");
    const reasons: string[] = [];
    s.on("close", (r) => reasons.push(r));
    io.close();
    expect(reasons[0]).toBe("closed by client");
  });
});

describe("壊れた入力で落ちない", () => {
  it("不正なバイト列が来ても接続を保つ", () => {
    const { s, io } = open();
    io.host("ok", 0xff, 0xfe, 0xfd);
    io.host("still here");
    expect(dec.decode(Uint8Array.from(text(s)[0]!.split("").map((c) => c.charCodeAt(0) & 0xff)))).toBeDefined();
    expect(text(s)[0]).toContain("ok");
  });
});
