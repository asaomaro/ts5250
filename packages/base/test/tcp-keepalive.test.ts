import { describe, it, expect } from "vitest";
import { tcpKeepAliveArgs } from "../src/tcp-keepalive.js";
describe("TCP keepalive timing", () => {
  it("既定と明示値を区別する", () => {
    expect(tcpKeepAliveArgs()).toEqual([true, 60000, 1000, 10]);
    expect(tcpKeepAliveArgs({ initialDelayMs: 30000, intervalMs: 10000, count: 6 })).toEqual([true, 30000, 10000, 6]);
  });
  it.each([{ initialDelayMs: 0 }, { intervalMs: 500 }, { intervalMs: 1500 }, { count: 0 }, { count: 128 }, { count: 1.5 }, { count: NaN }])("不正な値 %j を切り捨てず拒否する", (options) => {
    expect(() => tcpKeepAliveArgs(options)).toThrow(RangeError);
  });
});
