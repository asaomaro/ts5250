import { describe, it, expect, afterEach } from "vitest";
import { mount } from "@vue/test-utils";
import ReportText from "../src/components/ReportText.vue";
import { viewSettings } from "../src/stores/viewSettings.js";
import type { LogicalPage, ShiftMark } from "@ts5250/scs";

/**
 * **SO/SI の印の置き方**（`20260921-scs-sosi-columns`）。ACS と同じく SO/SI は既定で 1 桁ずつ占めるので、
 * 印はその桁の中に描く。占めない SO/SI（SPCC 0）は従来どおり境目に中心を置く。
 * ~~常に境目に中心~~ だと、占める桁があるのに印が前の字の右半分に重なった（独立点検の指摘）。
 */
function page(shifts: ShiftMark[][]): LogicalPage {
  return { rows: 1, cols: 12, lines: ["AB 日本語 CD"], raw: [[]], shifts };
}
describe("帳票の SO/SI の印", () => {
  afterEach(() => viewSettings.clearAll("r1"));

  it("**桁を占める SO/SI はその桁の中に描く**（`margin-left:0`・幅は占める桁ぶん）", () => {
    viewSettings.setOverride("r1", "sosi", "dim");
    const w = mount(ReportText, {
      props: { sessionId: "r1", pages: [page([[{ col: 3, kind: "so", width: 1 }, { col: 10, kind: "si", width: 2 }]])] }
    });
    const marks = w.findAll(".so");
    expect(marks).toHaveLength(2);
    const so = (marks[0]!.element as HTMLElement).style;
    expect([so.left, so.marginLeft, so.width]).toEqual(["2ch", "0px", "1ch"]);
    const si = (marks[1]!.element as HTMLElement).style;
    expect([si.left, si.marginLeft, si.width]).toEqual(["9ch", "0px", "2ch"]);
    w.unmount();
  });

  it("桁を占めない SO/SI（SPCC 0）は境目に中心を置く（CSS の既定のまま）", () => {
    viewSettings.setOverride("r1", "sosi", "dim");
    const w = mount(ReportText, { props: { sessionId: "r1", pages: [page([[{ col: 3, kind: "so", width: 0 }]])] } });
    const so = (w.find(".so").element as HTMLElement).style;
    expect(so.left).toBe("2ch");
    expect(so.marginLeft).toBe("");
    w.unmount();
  });
});

describe("帳票の重ね打ち・半分の幅・罫線（`20260930-scs-overlay`）", () => {
  afterEach(() => viewSettings.clearAll("r2"));
  const decorPage = (): LogicalPage => ({
    rows: 2,
    cols: 6,
    lines: ["___", "CD"],
    raw: [[], []],
    decor: [
      { glyphs: [{ x: 0, text: "A", scale: 1 }, { x: 1.5, text: "B", scale: 0.5 }, { x: 2, text: "あ", scale: 1 }] },
      { h: [{ x1: 0, x2: 5, dotted: false, weight: "pair" }], v: [{ x: 5, dotted: true, weight: "bold" }] }
    ]
  });

  it("重ねて描く字は行の箱に絶対配置で置く（半分の幅は scaleX・全角は 2 桁の幅）", () => {
    const w = mount(ReportText, { props: { sessionId: "r2", pages: [decorPage()] } });
    const gs = w.findAll(".og").map((g) => ({ t: g.text(), s: (g.element as HTMLElement).style }));
    expect(gs.map((g) => g.t)).toEqual(["A", "B", "あ"]);
    expect(gs[0]!.s.left).toBe("0ch");
    expect(gs[1]!.s.left).toBe("1.5ch");
    expect(gs[1]!.s.transform).toBe("scaleX(0.5)");
    expect(gs[2]!.s.width).toBe("2ch");
    w.unmount();
  });

  it("罫線: 横は行の下端（幅は桁ぶん・二重は double）、縦は桁位置（点線・太）", () => {
    const w = mount(ReportText, { props: { sessionId: "r2", pages: [decorPage()] } });
    const h = (w.find(".hr").element as HTMLElement).style;
    expect([h.left, h.width, h.borderBottomWidth, h.borderBottomStyle]).toEqual(["0ch", "5ch", "3px", "double"]);
    const v = (w.find(".vr").element as HTMLElement).style;
    expect([v.left, v.borderLeftWidth, v.borderLeftStyle]).toEqual(["5ch", "2px", "dotted"]);
    w.unmount();
  });

  it("decor の無い帳票は従来どおり（重ねる要素が出ない）", () => {
    const w = mount(ReportText, { props: { sessionId: "r2", pages: [{ rows: 1, cols: 2, lines: ["AB"], raw: [[]] }] } });
    expect(w.find(".og").exists()).toBe(false);
    expect(w.find(".hr").exists()).toBe(false);
    w.unmount();
  });
});
