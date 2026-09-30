import { describe, it, expect } from "vitest";
import { ScsDecoder, type LogicalPage } from "../src/scs.js";
import { codecForCcsid } from "@ts5250/ebcdic";

/**
 * **桁の格子に載らないもの**（`20260930-scs-overlay`）: 重ね打ちで下になった字・半分の幅の字・罫線（DGL）。期待値は ACS の JPS の描き方
 * （`PrintSCS5250JPS`・`JPSPrintableCharacters`・`JPSHorizontalGridLine`・`JPSState.clearVerticalGridLines`）を読んで決めたもの
 */
const c37 = codecForCcsid(37);
const E = (t: string): number[] => [...c37.encode(t).bytes];
const CR = 0x0d;
const NL = 0x15;
const FF = 0x0c;
const decode = (bytes: number[], ccsid = 37): LogicalPage[] => new ScsDecoder(ccsid).decode(Uint8Array.from(bytes));
const page = (bytes: number[], ccsid = 37): LogicalPage => decode(bytes, ccsid)[0]!;
const w16 = (n: number): number[] => [(n >> 8) & 0xff, n & 0xff];
const c1399 = codecForCcsid(1399);
/** 全角 1 字（SO・SI 付き。ACS の JPS は SO・SI を 1 桁ずつ占める） */
const wide = (t: string): number[] => [0x0e, ...[...c1399.encode(t).bytes].filter((b) => b !== 0x0e && b !== 0x0f), 0x0f];
/** 2B FD len 00 type sel positions… */
const dgl = (type: number, sel: number, ...positions: number[]): number[] => [
  0x2b, 0xfd, 4 + positions.length * 2, 0x00, type, sel, ...positions.flatMap(w16)
];
/** 桁の境目 k を 1/20 pt で（10 CPI＝字幅 7.2 pt＝144 単位） */
const col10 = (k: number): number => k * 144;

describe("重ね打ち（非空白×非空白）は先の字を残す", () => {
  it("`ABC` CR `___`（下線）: 格子は後の字、先の字は下の層に残る", () => {
    const p = page([...E("ABC"), CR, ...E("___")]);
    expect(p.lines).toEqual(["___"]);
    expect(p.decor?.[0]?.glyphs).toEqual([
      { x: 0, text: "A", scale: 1, raw: 0xc1 },
      { x: 1, text: "B", scale: 1, raw: 0xc2 },
      { x: 2, text: "C", scale: 1, raw: 0xc3 }
    ]);
  });

  it("二度打ち（太字）も残す: 同じ字を重ねても層に 1 つ増える（ACS は 2 回 drawString する）", () => {
    const p = page([...E("AB"), CR, ...E("AB")]);
    expect(p.lines).toEqual(["AB"]);
    expect(p.decor?.[0]?.glyphs?.map((g) => g.text)).toEqual(["A", "B"]);
  });

  it("三度打ちは 2 つ残る", () => {
    const p = page([...E("A"), CR, ...E("A"), CR, ...E("A")]);
    expect(p.decor?.[0]?.glyphs).toHaveLength(2);
  });

  it("空白は下の字を消さず、層にも何も足さない（`ABCDEF` CR `␠␠␠XY` は `ABCXYF`。`X`・`Y` に消された `D`・`E` だけが残る）", () => {
    const p = page([...E("ABCDEF"), CR, 0x40, 0x40, 0x40, ...E("XY")]);
    expect(p.lines).toEqual(["ABCXYF"]);
    expect(p.decor?.[0]?.glyphs?.map((g) => g.text)).toEqual(["D", "E"]);
  });

  it("重ねない帳票には decor を持たない（従来と同じ形）", () => {
    const p = page([...E("AB"), NL, ...E("CD")]);
    expect(p.decor).toBeUndefined();
  });

  it("全角の重ね打ち: 先の全角は 2 桁ぶんの字として残る", () => {
    const p = page([...wide("あ"), CR, ...wide("い")], 1399);
    expect(p.decor?.[0]?.glyphs?.map((g) => g.text)).toEqual(["あ"]);
    expect(p.lines[0]).toContain("い");
    expect(p.lines[0]).not.toContain("あ");
  });

  it("全角が半角 2 字の上に重なると、下の半角 2 字が両方残る（全角は 2 桁を占める）", () => {
    // SO は 1 桁を占める（空白は書かない）ので、全角は 2〜3 桁目。下の `ABC` の B・C が消される
    const p = page([...E("ABC"), CR, ...wide("あ")], 1399);
    expect(p.decor?.[0]?.glyphs?.map((g) => [g.x, g.text])).toEqual([
      [1, "B"],
      [2, "C"]
    ]);
  });

  it("行をまたぐと別の行の層（行ごとの添字）", () => {
    const p = page([...E("A"), NL, ...E("B"), CR, ...E("C")]);
    expect(p.decor?.[0]).toBeUndefined();
    expect(p.decor?.[1]?.glyphs?.map((g) => g.text)).toEqual(["B"]);
  });
});

describe("半分の幅（SFSS 0x08）は格子に載らないので重ねて描く", () => {
  const half = [0x2b, 0xfd, 0x04, 0x02, 0x08, 0x00];
  const reg = [0x2b, 0xfd, 0x04, 0x02, 0x10, 0x00];

  it("`AB` が 1 桁に入る: 格子は空白、字は 0.5 桁刻みで層へ。次の字は次の桁", () => {
    const p = page([...half, ...E("AB"), ...reg, ...E("C")]);
    expect(p.lines).toEqual([" C"]);
    expect(p.decor?.[0]?.glyphs).toEqual([
      { x: 0, text: "A", scale: 0.5, raw: 0xc1 },
      { x: 0.5, text: "B", scale: 0.5, raw: 0xc2 }
    ]);
    expect(p.cols).toBe(2);
  });

  it("半桁の位置で通常の幅に戻った字も、格子に置かず層へ（scale 1）", () => {
    const p = page([...half, ...E("A"), ...reg, ...E("B")]);
    expect(p.lines).toEqual([""]);
    expect(p.decor?.[0]?.glyphs).toEqual([
      { x: 0, text: "A", scale: 0.5, raw: 0xc1 },
      { x: 0.5, text: "B", scale: 1, raw: 0xc2 }
    ]);
    expect(p.cols).toBe(2);
  });

  it("半分の幅の全角は 1 桁ぶん（scale 0.5）で層へ。SO・SI の桁は半分にしない", () => {
    const p = page([...half, ...wide("あ"), ...reg, ...E("B")], 1399);
    // SO が 1 桁（x=0）、あ は x=1 から 1 桁ぶん、SI が 1 桁、B は x=3
    expect(p.decor?.[0]?.glyphs).toEqual([{ x: 1, text: "あ", scale: 0.5 }]);
    expect(p.lines[0]?.endsWith("B")).toBe(true);
  });

  it("空白は進むだけで層に字を足さない", () => {
    const p = page([...half, ...E("A"), 0x40, ...E("B")]);
    expect(p.decor?.[0]?.glyphs?.map((g) => [g.x, g.text])).toEqual([
      [0, "A"],
      [1, "B"]
    ]);
  });
});

describe("罫線（DGL `2B FD .. 00`）", () => {
  it("縦線は行が変わったあと、横線の命令で引かれる: 始まった行の次の行から今の行まで貫き、横線は今の行の下端", () => {
    const p = page([
      ...dgl(0, 0x40, col10(0), col10(5)), // 縦線 2 本（行 1 で始まる）
      ...E("AB"), NL, ...E("CD"), NL, ...E("EF"),
      ...dgl(0, 0x80, col10(0), col10(5)) // 横線（行 3）
    ]);
    expect(p.lines).toEqual(["AB", "CD", "EF"]);
    const thin = { dotted: false, weight: "thin" };
    expect(p.decor?.[0]).toBeUndefined();
    expect(p.decor?.[1]).toEqual({ v: [{ x: 0, ...thin }, { x: 5, ...thin }] });
    expect(p.decor?.[2]).toEqual({ v: [{ x: 0, ...thin }, { x: 5, ...thin }], h: [{ x1: 0, x2: 5, ...thin }] });
  });

  it("同じ行のうちは縦線を引かない（行が変わっていない）。ページの終わり（FF）までに引かれなかった縦線は捨てる", () => {
    const p = page([...dgl(0, 0x40, col10(2)), ...E("AB"), FF]);
    expect(p.decor).toBeUndefined();
  });

  it("縦線を足す命令は、行が変わっていれば先に溜めた縦線を引く", () => {
    const p = page([
      ...dgl(0, 0x40, col10(1)), ...E("A"), NL, ...E("B"), NL,
      ...dgl(0, 0x40, col10(3)) // 行 3 で 2 本目: 先の縦線（行 1 で始まる）を行 3 まで引く
    ]);
    expect(p.decor?.[1]?.v).toEqual([{ x: 1, dotted: false, weight: "thin" }]);
    expect(p.decor?.[2]?.v).toEqual([{ x: 1, dotted: false, weight: "thin" }]);
  });

  it("引いたあとは溜めが空になる: 続けて別の行で消しても同じ線をもう一度引かない", () => {
    const clear = [0x2b, 0xfd, 0x02, 0x00];
    const p = page([...dgl(0, 0x40, col10(1)), ...E("A"), NL, ...E("B"), ...clear, NL, NL, ...E("C"), ...clear]);
    expect(p.decor?.[1]?.v).toHaveLength(1);
    expect(p.decor?.[2]).toBeUndefined();
    expect(p.decor?.[3]).toBeUndefined();
  });

  it("同じ位置の縦線は 1 本にまとめる", () => {
    const p = page([...dgl(0, 0x40, col10(2), col10(2)), ...E("A"), NL, ...E("B"), 0x2b, 0xfd, 0x02, 0x00]);
    expect(p.decor?.[1]?.v).toHaveLength(1);
  });

  it("ページ（FF）をまたいで縦線の溜めを持ち越さない", () => {
    const p = decode([...dgl(0, 0x40, col10(1)), ...E("A"), FF, ...E("B"), NL, ...E("C"), 0x2b, 0xfd, 0x02, 0x00]);
    expect(p[1]?.decor).toBeUndefined();
  });

  it("位置の並びが奇数バイトの縦線（長さが奇数）は受けない", () => {
    const p = page([...E("A"), NL, ...E("B"), 0x2b, 0xfd, 0x07, 0x00, 0x00, 0x40, 0x00, 0x00, 0x90, NL, ...E("C"), 0x2b, 0xfd, 0x02, 0x00]);
    expect(p.decor).toBeUndefined();
  });

  it("「消す」（長さ 2 か選択 0）も溜めた縦線を引いて空にする", () => {
    const clear = [0x2b, 0xfd, 0x02, 0x00];
    const p = page([...dgl(0, 0x40, col10(1)), ...E("A"), NL, ...E("B"), ...clear, NL, ...E("C")]);
    expect(p.decor?.[1]?.v).toEqual([{ x: 1, dotted: false, weight: "thin" }]);
    expect(p.decor?.[2]).toBeUndefined();
    const p2 = page([...dgl(0, 0x40, col10(1)), ...E("A"), NL, ...E("B"), ...dgl(0, 0x00), NL, ...E("C")]);
    expect(p2.decor?.[1]?.v).toEqual([{ x: 1, dotted: false, weight: "thin" }]);
  });

  it("種類: 0 細・1 太・2 二重・8 点線の細・9 点線の太・10 点線の二重。知らない種類は命令ごと無視", () => {
    const styles = (type: number) =>
      page([...E("A"), ...dgl(type, 0x80, 0, col10(2))]).decor?.[0]?.h?.[0];
    expect(styles(0)).toMatchObject({ dotted: false, weight: "thin" });
    expect(styles(1)).toMatchObject({ dotted: false, weight: "bold" });
    expect(styles(2)).toMatchObject({ dotted: false, weight: "pair" });
    expect(styles(8)).toMatchObject({ dotted: true, weight: "thin" });
    expect(styles(9)).toMatchObject({ dotted: true, weight: "bold" });
    expect(styles(10)).toMatchObject({ dotted: true, weight: "pair" });
    expect(styles(3)).toBeUndefined();
    expect(styles(4)).toBeUndefined();
    expect(styles(11)).toBeUndefined();
  });

  it("「両方」（0xC0）は縦線を位置ごとに足し、最初と最後の位置の間に横線", () => {
    const p = page([...E("A"), NL, ...E("B"), ...dgl(0, 0xc0, col10(1), col10(4))]);
    expect(p.decor?.[1]?.h).toEqual([{ x1: 1, x2: 4, dotted: false, weight: "thin" }]);
    expect(p.decor?.[1]?.v).toBeUndefined(); // 縦線は横線と同じ行で始まったので、行が変わるまで溜めたまま（ACS `canClearVerticalGridLines`）
    // 次の行へ動いてから「消す」と、始まった行（2）の次の行（3）まで引かれる
    const q = page([...E("A"), NL, ...E("B"), ...dgl(0, 0xc0, col10(1), col10(4)), NL, ...E("C"), 0x2b, 0xfd, 0x02, 0x00]);
    expect(q.decor?.[2]?.v?.map((v) => v.x)).toEqual([1, 4]);
  });

  it("字幅は SCD で変わる: 12 CPI（6 pt）なら 720 単位＝6 桁", () => {
    const scd12 = [0x2b, 0xd2, 0x04, 0x29, 0x00, 0x0c];
    const p = page([...scd12, ...E("A"), ...dgl(0, 0x80, 0, 720)]);
    expect(p.decor?.[0]?.h).toEqual([{ x1: 0, x2: 6, dotted: false, weight: "thin" }]);
  });

  it("不正な長さ（4 より大きい奇数）は何もしない", () => {
    const p = page([...E("A"), 0x2b, 0xfd, 0x07, 0x00, 0x00, 0x80, 0, 0, 0]);
    expect(p.decor).toBeUndefined();
  });

  it("罫線だけのページも、その行までを含む", () => {
    const p = page([NL, NL, ...dgl(0, 0x80, 0, col10(3))]);
    expect(p.rows).toBe(3);
    expect(p.decor?.[2]?.h).toHaveLength(1);
  });
});
