import { describe, it, expect } from "vitest";
import { nextPaneInDirection, type PaneRect } from "../src/composables/paneNav.js";

// 2x2 レイアウト（各 100x100）
//   A(0,0) | B(100,0)
//   ------ + --------
//   C(0,100)| D(100,100)
const grid2x2: PaneRect[] = [
  { id: "A", left: 0, right: 100, top: 0, bottom: 100 },
  { id: "B", left: 100, right: 200, top: 0, bottom: 100 },
  { id: "C", left: 0, right: 100, top: 100, bottom: 200 },
  { id: "D", left: 100, right: 200, top: 100, bottom: 200 }
];

describe("nextPaneInDirection（空間ペインナビ）", () => {
  it("左右移動", () => {
    expect(nextPaneInDirection(grid2x2, "A", "right")).toBe("B");
    expect(nextPaneInDirection(grid2x2, "B", "left")).toBe("A");
    expect(nextPaneInDirection(grid2x2, "C", "right")).toBe("D");
  });

  it("上下移動", () => {
    expect(nextPaneInDirection(grid2x2, "A", "down")).toBe("C");
    expect(nextPaneInDirection(grid2x2, "C", "up")).toBe("A");
    expect(nextPaneInDirection(grid2x2, "B", "down")).toBe("D");
  });

  it("その方向にペインが無ければ undefined（端で停止）", () => {
    expect(nextPaneInDirection(grid2x2, "A", "left")).toBeUndefined();
    expect(nextPaneInDirection(grid2x2, "A", "up")).toBeUndefined();
    expect(nextPaneInDirection(grid2x2, "D", "right")).toBeUndefined();
    expect(nextPaneInDirection(grid2x2, "D", "down")).toBeUndefined();
  });

  it("真横を斜め上下より優先する（直交ズレを罰する）", () => {
    // A の右に、真横 B と 斜め下 D。right は B を選ぶ
    expect(nextPaneInDirection(grid2x2, "A", "right")).toBe("B");
  });

  it("左右 2 分割では上下移動しない", () => {
    const twoCol: PaneRect[] = [
      { id: "L", left: 0, right: 100, top: 0, bottom: 200 },
      { id: "R", left: 100, right: 200, top: 0, bottom: 200 }
    ];
    expect(nextPaneInDirection(twoCol, "L", "right")).toBe("R");
    expect(nextPaneInDirection(twoCol, "L", "up")).toBeUndefined();
    expect(nextPaneInDirection(twoCol, "L", "down")).toBeUndefined();
  });

  it("存在しない現在 id は undefined", () => {
    expect(nextPaneInDirection(grid2x2, "Z", "right")).toBeUndefined();
  });
});
