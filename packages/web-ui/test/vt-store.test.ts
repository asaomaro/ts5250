import { describe, it, expect, afterEach } from "vitest";
import { vtStore, lineText, textCols } from "../src/stores/vt.js";
import type { WsVtFrame } from "@ts5250/server";

/**
 * **サーバーは変わった行だけ送ってくる。** 前の状態に重ねて完全な画面を保つのがここの仕事。
 * 重ね方を間違えると「消えたはずの行が残る」「履歴が二重になる」という形で出る。
 */
const ids: string[] = [];
afterEach(() => {
  for (const id of ids.splice(0)) vtStore.remove(id);
});

function open(over: Partial<WsVtFrame> = {}): string {
  const id = `vt-${ids.length}`;
  ids.push(id);
  vtStore.create(
    id,
    {
      rows: 3,
      cols: 20,
      cursor: { row: 0, col: 0, visible: true },
      alternate: false,
      title: "",
      styles: [],
      lines: [],
      ...over
    },
    { encoding: "utf-8", ibmI: false, hostEchoes: true }
  );
  return id;
}

const frame = (over: Partial<WsVtFrame>): WsVtFrame => ({
  rows: 3,
  cols: 20,
  cursor: { row: 0, col: 0, visible: true },
  alternate: false,
  title: "",
  styles: [],
  lines: [],
  ...over
});

describe("差分を重ねる", () => {
  it("開いた直後は全行が入る", () => {
    const id = open({ lines: [{ row: 0, runs: [{ col: 0, text: "hello" }] }] });
    expect(vtStore.text(id)).toBe("hello\n\n");
  });

  it("**触れていない行はそのまま残る**", () => {
    const id = open({ lines: [{ row: 0, runs: [{ col: 0, text: "keep" }] }] });
    vtStore.apply(id, frame({ lines: [{ row: 1, runs: [{ col: 0, text: "new" }] }] }));
    expect(vtStore.text(id)).toBe("keep\nnew\n");
  });

  it("**空の runs で送られた行は消える**（消去がそのまま届く）", () => {
    const id = open({ lines: [{ row: 0, runs: [{ col: 0, text: "gone" }] }] });
    vtStore.apply(id, frame({ lines: [{ row: 0, runs: [] }] }));
    expect(vtStore.text(id)).toBe("\n\n");
  });

  it("行数が変わったら器を作り直す（古い行が残らない）", () => {
    const id = open({
      lines: [
        { row: 0, runs: [{ col: 0, text: "a" }] },
        { row: 2, runs: [{ col: 0, text: "c" }] }
      ]
    });
    vtStore.apply(id, frame({ rows: 2, lines: [{ row: 0, runs: [{ col: 0, text: "x" }] }] }));
    expect(vtStore.text(id)).toBe("x\n");
  });

  it("範囲外の行番号は捨てる（壊れたフレームで落ちない）", () => {
    const id = open();
    expect(() => vtStore.apply(id, frame({ lines: [{ row: 99, runs: [] }] }))).not.toThrow();
  });
});

describe("見た目", () => {
  it("palette の添字から解決する", () => {
    const id = open({
      styles: [{ fg: { kind: "indexed", index: 1 } }],
      lines: [{ row: 0, runs: [{ col: 0, text: "R", s: 0 }] }]
    });
    expect(vtStore.get(id)?.lines[0]?.[0]?.style).toEqual({ fg: { kind: "indexed", index: 1 } });
  });

  it("添字が無ければ既定（style を持たない）", () => {
    const id = open({ lines: [{ row: 0, runs: [{ col: 0, text: "x" }] }] });
    expect(vtStore.get(id)?.lines[0]?.[0]?.style).toBeUndefined();
  });
});

describe("スクロールバック", () => {
  it("増えたぶんを後ろに足す", () => {
    const id = open();
    vtStore.apply(id, frame({ scrollback: [[{ col: 0, text: "old1" }]] }));
    vtStore.apply(id, frame({ scrollback: [[{ col: 0, text: "old2" }]] }));
    expect(vtStore.get(id)?.scrollback.length).toBe(2);
    expect(vtStore.text(id, true).startsWith("old1\nold2")).toBe(true);
  });

  it("**頭から落ちたぶんを先に削る**（順番を逆にすると足した行まで消える）", () => {
    const id = open();
    vtStore.apply(id, frame({ scrollback: [[{ col: 0, text: "1" }], [{ col: 0, text: "2" }]] }));
    vtStore.apply(id, frame({ scrollbackDropped: 1, scrollback: [[{ col: 0, text: "3" }]] }));
    const sb = vtStore.get(id)?.scrollback.map((l) => lineText(l));
    expect(sb).toEqual(["2", "3"]);
  });

  it("**代替画面では履歴を混ぜない**（vi の背後に履歴が見えるのはおかしい）", () => {
    const id = open({ lines: [{ row: 0, runs: [{ col: 0, text: "alt" }] }] });
    vtStore.apply(id, frame({ scrollback: [[{ col: 0, text: "hist" }]] }));
    vtStore.apply(id, frame({ alternate: true, lines: [{ row: 0, runs: [{ col: 0, text: "vi" }] }] }));
    expect(vtStore.text(id, true)).not.toContain("hist");
  });
});

describe("桁の勘定", () => {
  it("**全角は 2 桁**（文字数で数えるとずれる）", () => {
    expect(textCols("あ")).toBe(2);
    expect(textCols("あA")).toBe(3);
    expect(textCols("ABC")).toBe(3);
  });

  it("run の間は空白で埋まる", () => {
    expect(lineText([{ col: 0, text: "A" }, { col: 4, text: "B" }])).toBe("A   B");
  });

  it("**全角のあとの run が正しい桁に来る**", () => {
    // あ(0,1) → 次の run は 3 桁目
    expect(lineText([{ col: 0, text: "あ" }, { col: 3, text: "X" }])).toBe("あ X");
  });

  it("行末の余白は落とす", () => {
    expect(lineText([{ col: 0, text: "A   " }])).toBe("A");
  });
});

describe("状態", () => {
  it("タイトル・接続・追従を持つ", () => {
    const id = open();
    vtStore.setTitle(id, "T");
    expect(vtStore.get(id)?.title).toBe("T");
    vtStore.setConnected(id, false);
    expect(vtStore.get(id)?.connected).toBe(false);
    vtStore.setFollowTail(id, false);
    expect(vtStore.get(id)?.followTail).toBe(false);
  });

  it("知らない id への操作で落ちない", () => {
    expect(() => vtStore.apply("nope", frame({}))).not.toThrow();
    expect(vtStore.text("nope")).toBe("");
  });
});
