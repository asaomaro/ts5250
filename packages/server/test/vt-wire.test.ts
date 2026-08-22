import { describe, it, expect } from "vitest";
import { VtParser, VtTerminal } from "@ts5250/vt";
import { VtFrameBuilder } from "../src/vt-wire.js";

const enc = new TextEncoder();

function terminal(rows = 5, cols = 20): { t: VtTerminal; feed: (s: string) => void } {
  const t = new VtTerminal(rows, cols, 100);
  const p = new VtParser();
  return { t, feed: (s: string) => t.handle(p.feed(enc.encode(s))) };
}

/** run を「桁: 文字」の読める形に */
const shown = (frame: ReturnType<VtFrameBuilder["build"]>): string[] =>
  (frame?.lines ?? []).map(
    (l) => `${l.row}: ` + l.runs.map((r) => `${r.col}"${r.text}"${r.s !== undefined ? `#${r.s}` : ""}`).join(" ")
  );

describe("最初の 1 通は全行", () => {
  it("full を立てると変わっていない行も出る", () => {
    const { t, feed } = terminal();
    feed("ab");
    const f = new VtFrameBuilder().build(t.snapshot(), true);
    expect(f?.lines.length).toBe(5);
  });
});

describe("差分だけ送る", () => {
  it("**変わった行だけ**出る", () => {
    const { t, feed } = terminal();
    const b = new VtFrameBuilder();
    feed("line1\r\nline2");
    b.build(t.snapshot(), true);
    feed("\x1b[3;1Hline3");
    expect(shown(b.build(t.snapshot()))).toEqual(['2: 0"line3"']);
  });

  it("**何も変わらなければ undefined**（空の通で回線を埋めない）", () => {
    const { t, feed } = terminal();
    const b = new VtFrameBuilder();
    feed("x");
    b.build(t.snapshot(), true);
    expect(b.build(t.snapshot())).toBeUndefined();
  });

  it("**文字が同じでも色が変われば送る**", () => {
    const { t, feed } = terminal();
    const b = new VtFrameBuilder();
    feed("abc");
    b.build(t.snapshot(), true);
    feed("\x1b[1;1H\x1b[31mabc");
    expect(b.build(t.snapshot())?.lines.length).toBe(1);
  });

  it("カーソルが動いただけでも送る（画面側が箱を動かせるように）", () => {
    const { t, feed } = terminal();
    const b = new VtFrameBuilder();
    feed("abc");
    b.build(t.snapshot(), true);
    feed("\x1b[2;5H");
    const f = b.build(t.snapshot());
    expect(f?.lines).toEqual([]);
    expect(f?.cursor).toEqual({ row: 1, col: 4, visible: true });
  });

  it("大きさが変わったら全行を出し直す", () => {
    const { t, feed } = terminal();
    const b = new VtFrameBuilder();
    feed("abc");
    b.build(t.snapshot(), true);
    t.resize(3, 20);
    expect(b.build(t.snapshot())?.lines.length).toBe(3);
  });
});

describe("run にまとめる", () => {
  it("**行末の余白は落とす**（1 行 80 桁の大半がこれ）", () => {
    const { t, feed } = terminal();
    feed("ab");
    const f = new VtFrameBuilder().build(t.snapshot(), true);
    expect(f?.lines[0]?.runs).toEqual([{ col: 0, text: "ab" }]);
    expect(f?.lines[1]?.runs).toEqual([]);
  });

  it("**背景色の付いた空白は残す**（塗られている）", () => {
    const { t, feed } = terminal();
    feed("\x1b[41m\x1b[1;1H\x1b[3X");
    const f = new VtFrameBuilder().build(t.snapshot(), true);
    expect(f?.lines[0]?.runs[0]?.text).toBe("   ");
  });

  it("同じ見た目が続けば 1 つの run になる", () => {
    const { t, feed } = terminal();
    feed("\x1b[31mabc\x1b[0mdef");
    const f = new VtFrameBuilder().build(t.snapshot(), true);
    expect(shown(f)[0]).toBe('0: 0"abc"#0 3"def"');
  });

  it("**見た目は palette に括る**（同じものは 1 つだけ）", () => {
    const { t, feed } = terminal();
    feed("\x1b[31ma\x1b[0mb\x1b[31mc");
    const f = new VtFrameBuilder().build(t.snapshot(), true);
    expect(f?.styles).toEqual([{ fg: { kind: "indexed", index: 1 } }]);
    expect(f?.lines[0]?.runs.map((r) => r.s)).toEqual([0, undefined, 0]);
  });

  it("**既定の見た目は palette に入れない**（大半のセルがこれ）", () => {
    const { t, feed } = terminal();
    feed("plain");
    expect(new VtFrameBuilder().build(t.snapshot(), true)?.styles).toEqual([]);
  });

  it("256 色・24 ビット色がそのまま乗る", () => {
    const { t, feed } = terminal();
    feed("\x1b[38;5;208mA\x1b[38;2;1;2;3mB");
    const f = new VtFrameBuilder().build(t.snapshot(), true);
    expect(f?.styles).toEqual([
      { fg: { kind: "indexed", index: 208 } },
      { fg: { kind: "rgb", r: 1, g: 2, b: 3 } }
    ]);
  });
});

describe("全角", () => {
  it("**継続セルは送らない**（等幅なら全角そのものが 2 桁を占める）", () => {
    const { t, feed } = terminal();
    feed("あいX");
    const f = new VtFrameBuilder().build(t.snapshot(), true);
    expect(f?.lines[0]?.runs).toEqual([{ col: 0, text: "あいX" }]);
  });

  it("**全角のあとの桁が正しく続く**（継続セルを飛ばしたぶんを勘定し直す）", () => {
    const { t, feed } = terminal();
    feed("あ\x1b[1;4H\x1b[31mR");
    const f = new VtFrameBuilder().build(t.snapshot(), true);
    // あ(0,1) 空白(2) R(3)
    expect(shown(f)[0]).toBe('0: 0"あ " 3"R"#0');
  });
});

describe("スクロールバック", () => {
  it("**増えたぶんだけ**送る", () => {
    const { t, feed } = terminal(3, 10);
    const b = new VtFrameBuilder();
    feed("1\r\n2\r\n3");
    b.build(t.snapshot(), true);
    feed("\r\n4");
    const f = b.build(t.snapshot());
    expect(f?.scrollback?.length).toBe(1);
    expect(f?.scrollback?.[0]).toEqual([{ col: 0, text: "1" }]);
  });

  it("増えていなければ付けない", () => {
    const { t, feed } = terminal();
    const b = new VtFrameBuilder();
    feed("x");
    b.build(t.snapshot(), true);
    feed("y");
    expect(b.build(t.snapshot())?.scrollback).toBeUndefined();
  });

  it("**上限に達して捨てられたら本数を伝える**（画面側が頭を落とせるように）", () => {
    const t = new VtTerminal(3, 10, 2);
    const p = new VtParser();
    const b = new VtFrameBuilder();
    t.handle(p.feed(enc.encode("1\r\n2\r\n3\r\n4\r\n5")));
    b.build(t.snapshot(), true);
    t.handle(p.feed(enc.encode("\r\n6\r\n7")));
    const f = b.build(t.snapshot());
    expect(f?.scrollbackDropped).toBeGreaterThan(0);
  });

  it("**代替画面ではスクロールバックが増えない**", () => {
    const { t, feed } = terminal(3, 10);
    const b = new VtFrameBuilder();
    b.build(t.snapshot(), true);
    feed("\x1b[?1049h" + "x\r\n".repeat(10));
    expect(b.build(t.snapshot())?.scrollback).toBeUndefined();
  });
});

describe("代替画面とタイトル", () => {
  it("フレームに載る", () => {
    const { t, feed } = terminal();
    feed("\x1b]0;My Title\x07\x1b[?1049h");
    const f = new VtFrameBuilder().build(t.snapshot(), true);
    expect(f?.alternate).toBe(true);
    expect(f?.title).toBe("My Title");
  });
});

describe("reset", () => {
  it("次の 1 通が全行になる（再購読・リサイズのあと）", () => {
    const { t, feed } = terminal();
    const b = new VtFrameBuilder();
    feed("x");
    b.build(t.snapshot(), true);
    expect(b.build(t.snapshot())).toBeUndefined();
    b.reset();
    expect(b.build(t.snapshot())?.lines.length).toBe(5);
  });
});
