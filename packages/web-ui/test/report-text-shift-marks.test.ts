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
