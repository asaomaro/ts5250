import { describe, it, expect } from "vitest";
import { onDisplayLost, onDisplayConnected, otherDisplayAssociated, shouldClosePrinter } from "../src/associated-printer.js";

/**
 * **関連付けたプリンターと表示の連動の判断**（ACS `AssociatedPrinterSession5250.CommEvent` / `sessionLabelEvent`。
 * `20260921-associated-printer-session`）。常駐のプリンターは触らない（decisions D2）
 */
const running = { resident: false, running: true };
const stopped = { resident: false, running: false };
const resident = { resident: true, running: true };

describe("ほかの表示が使っているか", () => {
  it("同じプリンターへ関連付けた、繋がっている表示があれば true（繋ぎ直し中・別のプリンター・関連付けなしは数えない）", () => {
    expect(otherDisplayAssociated("p", [{ printerId: "p", connected: true }])).toBe(true);
    expect(otherDisplayAssociated("p", [{ printerId: "p", connected: false }])).toBe(false);
    expect(otherDisplayAssociated("p", [{ printerId: "q", connected: true }, { printerId: undefined, connected: true }])).toBe(false);
    expect(otherDisplayAssociated("p", [])).toBe(false);
  });
});

describe("表示が切れたとき", () => {
  it("ほかに使う表示が無ければプリンターを止める", () => {
    expect(onDisplayLost(running, false)).toBe("stop");
  });
  it("ほかの表示が使っていれば止めない", () => {
    expect(onDisplayLost(running, true)).toBe("none");
  });
  it("常駐のプリンターは止めない", () => {
    expect(onDisplayLost(resident, false)).toBe("none");
  });
  it("止まっているものには何もしない", () => {
    expect(onDisplayLost(stopped, false)).toBe("none");
  });
});

describe("表示が繋がったとき", () => {
  it("止まっていれば起こす。動いていれば何もしない", () => {
    expect(onDisplayConnected(stopped)).toBe("start");
    expect(onDisplayConnected(running)).toBe("none");
  });
});

describe("表示を閉じたとき", () => {
  it("指定があり、ほかに使う表示が無ければ閉じる", () => {
    expect(shouldClosePrinter(running, true, false)).toBe(true);
  });
  it("指定が無ければ閉じない・ほかの表示が使っていれば閉じない・常駐は閉じない", () => {
    expect(shouldClosePrinter(running, false, false)).toBe(false);
    expect(shouldClosePrinter(running, true, true)).toBe(false);
    expect(shouldClosePrinter(resident, true, false)).toBe(false);
  });
});
