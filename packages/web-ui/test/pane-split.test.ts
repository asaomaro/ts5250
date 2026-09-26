import { describe, it, expect } from "vitest";
import { mount } from "@vue/test-utils";
import { usePaneSplit } from "../src/composables/usePaneSplit.js";
import PaneSplitter from "../src/components/PaneSplitter.vue";

/**
 * 境界のドラッグ（`usePaneSplit`＋`PaneSplitter`）。上下（SQL／スプール）と左右（IFS。
 * `20260924-vscode-extension` D18）を同じ部品で扱う。
 */

/** jsdom は setPointerCapture を持たないので、ドラッグに要る分だけ用意する */
function pointer(type: string, x: number, y: number): PointerEvent {
  const e = new Event(type, { bubbles: true, cancelable: true }) as PointerEvent;
  Object.assign(e, { clientX: x, clientY: y, pointerId: 1 });
  return e;
}
function stubCapture(el: Element): void {
  Object.assign(el, { setPointerCapture: () => {}, releasePointerCapture: () => {} });
}

describe("usePaneSplit", () => {
  it("既定（axis:y）は縦の移動量で前側の大きさが変わり、横の移動は無視する", async () => {
    const split = usePaneSplit({ initial: 100, min: 50, max: 300 });
    const w = mount(PaneSplitter, { props: { split, label: "高さ" } });
    stubCapture(w.element);
    w.element.dispatchEvent(pointer("pointerdown", 10, 10));
    w.element.dispatchEvent(pointer("pointermove", 500, 40));
    w.element.dispatchEvent(pointer("pointerup", 500, 40));
    expect(split.size.value).toBe(130);
  });

  it("axis:x は横の移動量で前側（左列）の幅が変わり、縦の移動は無視する", async () => {
    const split = usePaneSplit({ initial: 200, min: 100, max: 400, axis: "x" });
    const w = mount(PaneSplitter, { props: { split, label: "幅", vertical: true } });
    stubCapture(w.element);
    w.element.dispatchEvent(pointer("pointerdown", 10, 10));
    w.element.dispatchEvent(pointer("pointermove", 60, 500));
    w.element.dispatchEvent(pointer("pointerup", 60, 500));
    expect(split.size.value).toBe(250);
  });

  it("min/max で止まる", () => {
    const split = usePaneSplit({ initial: 200, min: 100, max: 400, axis: "x" });
    const w = mount(PaneSplitter, { props: { split, label: "幅", vertical: true } });
    stubCapture(w.element);
    w.element.dispatchEvent(pointer("pointerdown", 0, 0));
    w.element.dispatchEvent(pointer("pointermove", 9999, 0));
    expect(split.size.value).toBe(400);
    w.element.dispatchEvent(pointer("pointermove", -9999, 0));
    expect(split.size.value).toBe(100);
  });

  it("キーボード: axis:x は左右キー、axis:y は上下キーで動く（向きの違うキーは無視）", async () => {
    const x = usePaneSplit({ initial: 200, axis: "x" });
    const wx = mount(PaneSplitter, { props: { split: x, label: "幅", vertical: true } });
    await wx.trigger("keydown", { key: "ArrowRight" });
    expect(x.size.value).toBe(210);
    await wx.trigger("keydown", { key: "ArrowDown" });
    expect(x.size.value).toBe(210); // 縦のキーは左右の境界では効かない

    const y = usePaneSplit({ initial: 200 });
    const wy = mount(PaneSplitter, { props: { split: y, label: "高さ" } });
    await wy.trigger("keydown", { key: "ArrowDown" });
    expect(y.size.value).toBe(210);
    await wy.trigger("keydown", { key: "ArrowRight" });
    expect(y.size.value).toBe(210); // 横のキーは上下の境界では効かない
  });

  it("vertical の境界は縦向きの separator として名乗る（支援技術に向きと操作を伝える）", () => {
    const w = mount(PaneSplitter, { props: { split: usePaneSplit({ initial: 1, axis: "x" }), label: "幅", vertical: true } });
    expect(w.attributes("aria-orientation")).toBe("vertical");
    expect(w.attributes("aria-label")).toContain("左右キー");
    expect(w.classes()).toContain("vertical");
  });
});
