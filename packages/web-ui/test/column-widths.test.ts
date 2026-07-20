import { describe, it, expect } from "vitest";
import { useColumnWidths } from "../src/composables/useColumnWidths.js";

/**
 * 列幅の共通実装。**SQL ペインとデータ転送ペインが同じ振る舞いになる**ことが目的なので、
 * composable として固定する（片方だけ直す事故を防ぐ）。
 */
function down(index: number, x: number, width: number) {
  const th = { getBoundingClientRect: () => ({ width }) };
  return {
    clientX: x,
    pointerId: 1,
    currentTarget: { parentElement: th, setPointerCapture: undefined, releasePointerCapture: undefined },
    preventDefault() {},
    stopPropagation() {}
  } as unknown as PointerEvent;
}
const move = (x: number) => ({ clientX: x }) as unknown as PointerEvent;
const up = () =>
  ({ pointerId: 1, currentTarget: { releasePointerCapture: undefined } }) as unknown as PointerEvent;

describe("useColumnWidths", () => {
  it("**既定では幅を指定しない**（CSS の中身合わせに任せる）", () => {
    const c = useColumnWidths();
    expect(c.widthStyle(0)).toBeUndefined();
  });

  it("ドラッグした量だけ幅が変わる", () => {
    const c = useColumnWidths();
    c.onDown(down(0, 100, 80), 0);
    c.onMove(move(150)); // +50
    expect(c.widthStyle(0)).toEqual({ width: "130px", minWidth: "130px", maxWidth: "130px" });
  });

  it("**max-width も同じ値にする**——打ち切りの基準が動かないと広げても見えない", () => {
    const c = useColumnWidths();
    c.onDown(down(0, 0, 100), 0);
    c.onMove(move(200));
    const style = c.widthStyle(0)!;
    expect(style.maxWidth).toBe(style.width);
  });

  it("狭めても掴める下限で止まる", () => {
    const c = useColumnWidths();
    c.onDown(down(0, 500, 100), 0);
    c.onMove(move(0)); // 大きく左へ
    expect(c.widthStyle(0)!.width).toBe("40px");
  });

  it("列ごとに独立している（位置で持つ）", () => {
    const c = useColumnWidths();
    c.onDown(down(0, 0, 50), 1);
    c.onMove(move(30));
    expect(c.widthStyle(0)).toBeUndefined();
    expect(c.widthStyle(1)).toBeDefined();
  });

  it("ドラッグ中の列が分かる（掴み手の見た目に使う）", () => {
    const c = useColumnWidths();
    expect(c.resizing.value).toBe(-1);
    c.onDown(down(0, 0, 50), 2);
    expect(c.resizing.value).toBe(2);
    c.onUp(up());
    expect(c.resizing.value).toBe(-1);
  });

  it("掴んでいないときの move は無視する", () => {
    const c = useColumnWidths();
    c.onMove(move(999));
    expect(c.widthStyle(0)).toBeUndefined();
  });

  it("reset で既定へ戻す", () => {
    const c = useColumnWidths();
    c.onDown(down(0, 0, 50), 0);
    c.onMove(move(30));
    c.reset(0);
    expect(c.widthStyle(0)).toBeUndefined();
  });

  it("**clear は全部捨てる**（列の並びが変わったら呼ぶ）", () => {
    const c = useColumnWidths();
    c.onDown(down(0, 0, 50), 0);
    c.onMove(move(30));
    c.onUp(up());
    c.onDown(down(0, 0, 50), 1);
    c.onMove(move(30));
    c.clear();
    expect(c.widthStyle(0)).toBeUndefined();
    expect(c.widthStyle(1)).toBeUndefined();
  });
});
