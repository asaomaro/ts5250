import { describe, it, expect } from "vitest";
import { fitFont } from "../src/composables/fitFont.js";

describe("fitFont", () => {
  it("幅が制約になる場合は幅基準（横を縮めると小さくなる）", () => {
    // 24x80。高さは十分、幅が狭い → byWidth が効く
    const px = fitFont(500, 2000, 80, 24);
    // byWidth = (500-20)/80/0.6 = 10、byHeight = (2000-16)/24/1.25 ≈ 66 → min=10
    expect(px).toBeCloseTo(10, 1);
  });

  it("高さが制約になる場合は高さ基準（縦を縮めると小さくなる）", () => {
    // 幅は十分、高さが低い → byHeight が効く（縦縮小で縮尺追従）
    const tall = fitFont(4000, 600, 80, 24);
    // byHeight = (600-16)/24/1.25 ≈ 19.5、byWidth = (4000-20)/80/0.6 ≈ 82.9 → min≈19.5
    expect(tall).toBeCloseTo(19.5, 0);
  });

  it("縦を縮めるとフォントが小さくなる（縦横で縮尺が変わる）", () => {
    const big = fitFont(1200, 900, 80, 24);
    const shorter = fitFont(1200, 500, 80, 24);
    expect(shorter).toBeLessThan(big); // 高さ縮小でフォント縮小
  });

  it("最小 6px・最大 32px にクランプする", () => {
    expect(fitFont(100, 100, 80, 24)).toBe(6); // 極小
    expect(fitFont(100000, 100000, 80, 24)).toBe(32); // 極大
  });

  it("27x132 ワイドでも両制約で最小側に合わせる", () => {
    const px = fitFont(1320, 400, 132, 27);
    // byWidth = (1320-20)/132/0.6 ≈ 16.4、byHeight = (400-16)/27/1.25 ≈ 11.4 → min≈11.4
    expect(px).toBeCloseTo(11.4, 0);
  });
});
