import { describe, it, expect } from "vitest";
import { terminalTypeFor, isDbcsCcsid } from "../src/session/terminal-type.js";
import { ScreenBuffer } from "../src/screen/buffer.js";

describe("terminalTypeFor", () => {
  it("SBCS/DBCS × 24x80/27x132 の端末タイプを返す", () => {
    expect(terminalTypeFor(37, "24x80")).toBe("IBM-3179-2");
    expect(terminalTypeFor(37, "27x132")).toBe("IBM-3477-FC");
    expect(terminalTypeFor(1399, "24x80")).toBe("IBM-5555-C01");
    expect(terminalTypeFor(1399, "27x132")).toBe("IBM-5555-B01");
    expect(terminalTypeFor(930, "24x80")).toBe("IBM-5555-C01");
  });
  it("DBCS CCSID を判定する", () => {
    expect(isDbcsCcsid(1399)).toBe(true);
    expect(isDbcsCcsid(37)).toBe(false);
  });
});

describe("ScreenBuffer 27x132 代替バッファ", () => {
  it("既定は 24x80", () => {
    const b = new ScreenBuffer();
    const s = b.snapshot("t", false);
    expect(s.rows).toBe(24);
    expect(s.cols).toBe(80);
  });

  it("alternate 許可時、CLEAR UNIT ALTERNATE で 27x132 に切替わる", () => {
    const b = new ScreenBuffer({ alternate: "27x132" });
    expect(b.clearUnitAlternate()).toBe(true);
    expect(b.rows).toBe(27);
    expect(b.cols).toBe(132);
    const s = b.snapshot("t", false);
    expect(s.cells).toHaveLength(27);
    expect(s.cells[0]).toHaveLength(132);
  });

  it("alternate 未許可（24x80 端末）では false", () => {
    const b = new ScreenBuffer();
    expect(b.clearUnitAlternate()).toBe(false);
    expect(b.rows).toBe(24);
  });

  it("CLEAR UNIT で 24x80 に戻る", () => {
    const b = new ScreenBuffer({ alternate: "27x132" });
    b.clearUnitAlternate();
    expect(b.cols).toBe(132);
    b.clearUnit();
    expect(b.rows).toBe(24);
    expect(b.cols).toBe(80);
  });
});
