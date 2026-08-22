import { describe, it, expect } from "vitest";
import { VtParser, parseParams, type VtEvent } from "../src/protocol/parser.js";

const enc = new TextEncoder();
const feed = (p: VtParser, s: string): VtEvent[] => p.feed(enc.encode(s));
const all = (s: string, opts = {}): VtEvent[] => feed(new VtParser(opts), s);

describe("印字と C0", () => {
  it("普通の文字はまとめて 1 つの print になる", () => {
    expect(all("hello")).toEqual([{ kind: "print", text: "hello" }]);
  });

  it("C0 は print を切って execute になる", () => {
    expect(all("ab\rcd")).toEqual([
      { kind: "print", text: "ab" },
      { kind: "execute", code: 0x0d },
      { kind: "print", text: "cd" }
    ]);
  });

  it("DEL(0x7f) も execute として出す", () => {
    expect(all("a\x7f")).toEqual([
      { kind: "print", text: "a" },
      { kind: "execute", code: 0x7f }
    ]);
  });
});

describe("CSI", () => {
  it("パラメータなし", () => {
    expect(all("\x1b[H")).toEqual([
      { kind: "csi", prefix: "", params: [], intermediates: "", final: "H" }
    ]);
  });

  it("パラメータつき", () => {
    expect(all("\x1b[12;34H")).toEqual([
      { kind: "csi", prefix: "", params: [12, 34], intermediates: "", final: "H" }
    ]);
  });

  it("**空のパラメータは undefined**（0 と区別する）", () => {
    expect(all("\x1b[;5H")).toEqual([
      { kind: "csi", prefix: "", params: [undefined, 5], intermediates: "", final: "H" }
    ]);
  });

  it("プレフィクス `?` `>` を分けて持つ（DECSET / DA2）", () => {
    expect(all("\x1b[?1049h")[0]).toMatchObject({ prefix: "?", params: [1049], final: "h" });
    expect(all("\x1b[>4;2m")[0]).toMatchObject({ prefix: ">", params: [4, 2], final: "m" });
  });

  it("中間バイトを分けて持つ（`ESC [ ! p` = DECSTR）", () => {
    expect(all("\x1b[!p")[0]).toMatchObject({ intermediates: "!", final: "p" });
  });

  it("**コロンの下位パラメータ**（`38:2::r:g:b`）", () => {
    expect(all("\x1b[38:2::10:20:30m")[0]).toMatchObject({
      params: [[38, 2, undefined, 10, 20, 30]]
    });
  });
});

describe("ESC", () => {
  it("単独（DECSC / DECKPAM）", () => {
    expect(all("\x1b7")).toEqual([{ kind: "esc", intermediates: "", final: "7" }]);
    expect(all("\x1b=")).toEqual([{ kind: "esc", intermediates: "", final: "=" }]);
  });

  it("中間バイトつき（文字集合の指定 `ESC ( B`）", () => {
    expect(all("\x1b(B")).toEqual([{ kind: "esc", intermediates: "(", final: "B" }]);
    expect(all("\x1b(0")).toEqual([{ kind: "esc", intermediates: "(", final: "0" }]);
  });
});

describe("OSC", () => {
  it("BEL で終わる（`OSC 0 ; タイトル BEL`）", () => {
    expect(all("\x1b]0;My Title\x07")).toEqual([
      { kind: "osc", command: 0, data: "My Title" }
    ]);
  });

  it("ST（`ESC \\`）でも終わる", () => {
    expect(all("\x1b]2;T\x1b\\")).toEqual([{ kind: "osc", command: 2, data: "T" }]);
  });

  it("本文が長すぎるものは捨てる（暴走したホストで詰まらせない）", () => {
    const p = new VtParser({ maxStringLength: 8 });
    expect(feed(p, "\x1b]0;" + "x".repeat(50) + "\x07")).toEqual([]);
  });
});

describe("DCS", () => {
  it("本文つきで拾える（中身は今は使わないが、来た事実は伝える）", () => {
    expect(all("\x1bP1$r0m\x1b\\")).toEqual([
      { kind: "dcs", params: [1], intermediates: "$", final: "r", data: "0m" }
    ]);
  });
});

describe("壊れた入力で止まらない", () => {
  it("CSI の途中にプレフィクスが来たら**その列だけ捨てる**", () => {
    expect(all("\x1b[1?2mX")).toEqual([{ kind: "print", text: "X" }]);
  });

  it("CAN / SUB は進行中の列を捨てる", () => {
    expect(all("\x1b[12\x18H")).toEqual([{ kind: "print", text: "H" }]);
  });

  it("列の途中の ESC は**新しい列の始まり**として読み直す", () => {
    expect(all("\x1b[12\x1b[H")).toEqual([
      { kind: "csi", prefix: "", params: [], intermediates: "", final: "H" }
    ]);
  });

  it("終端まで来ない列を食わせても例外にならない", () => {
    expect(() => all("\x1b[38;5;")).not.toThrow();
  });
});

describe("分割到着", () => {
  it("**エスケープ列がバイト境界で割れても繋ぐ**", () => {
    const p = new VtParser();
    expect(feed(p, "\x1b")).toEqual([]);
    expect(feed(p, "[")).toEqual([]);
    expect(feed(p, "1")).toEqual([]);
    expect(feed(p, "2;3")).toEqual([]);
    expect(feed(p, "H")).toEqual([
      { kind: "csi", prefix: "", params: [12, 3], intermediates: "", final: "H" }
    ]);
  });

  it("**UTF-8 の多バイトが割れても繋ぐ**", () => {
    const p = new VtParser();
    expect(p.feed(Uint8Array.of(0xe3, 0x81))).toEqual([]);
    expect(p.feed(Uint8Array.of(0x82))).toEqual([{ kind: "print", text: "あ" }]);
  });
});

describe("8 ビット C1", () => {
  it("**既定では採らない**——0x9b は文字の一部（UTF-8 / Shift_JIS と衝突するため）", () => {
    const p = new VtParser({ encoding: "shift_jis" });
    // Shift_JIS の「あ」= 82 a0。0x82 を CSI と誤読してはならない
    expect(p.feed(Uint8Array.of(0x82, 0xa0))).toEqual([{ kind: "print", text: "あ" }]);
  });

  it("明示的に開ければ 0x9b を CSI として扱う", () => {
    const p = new VtParser({ eightBitControls: true });
    expect(p.feed(Uint8Array.of(0x9b, 0x48))).toEqual([
      { kind: "csi", prefix: "", params: [], intermediates: "", final: "H" }
    ]);
  });
});

describe("実機で採取した列（research 2.1）", () => {
  it("vi に入るときの一続きを全部読み切る", () => {
    const s =
      "\x1b[?1049h\x1b[22;0;0t\x1b[>4;2m\x1b[?1h\x1b=\x1b[?2004h\x1b[1;24r" +
      "\x1b[?12h\x1b[?12l\x1b[27m\x1b[23m\x1b[29m\x1b[m\x1b[H\x1b[2J\x1b[?25l";
    const ev = all(s);
    expect(ev.filter((e) => e.kind === "print")).toEqual([]);
    expect(ev.map((e) => (e.kind === "csi" ? e.prefix + e.final : e.kind === "esc" ? "ESC" + e.final : "?")))
      .toEqual(["?h", "t", ">m", "?h", "ESC=", "?h", "r", "?h", "?l", "m", "m", "m", "m", "H", "J", "?l"]);
  });

  it("IBM i（pub400）のサインオンの先頭", () => {
    const ev = all("\x1b[?3l\x1b[?7h\x1b[5;25H\x1b[1;1H\x1b[2J\x1b[0m  Welcome");
    expect(ev.at(-1)).toEqual({ kind: "print", text: "  Welcome" });
    expect(ev[0]).toMatchObject({ prefix: "?", params: [3], final: "l" });
    expect(ev[2]).toMatchObject({ params: [5, 25], final: "H" });
  });
});

describe("parseParams", () => {
  it("空文字列は空配列", () => {
    expect(parseParams("")).toEqual([]);
  });
  it("数値でない断片は undefined", () => {
    expect(parseParams("1;;3")).toEqual([1, undefined, 3]);
  });
});
