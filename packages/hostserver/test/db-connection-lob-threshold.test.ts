import { describe, it, expect } from "vitest";
import { clampLobThreshold } from "../src/db/db-connection.js";

/**
 * LOB フィールドしきい値の丸め。
 *
 * **既定は 0＝常にロケーター**。上げるのは明示指定のときだけで、
 * 上限は原典（JTOpen）と同じ 15,728,640——公表の 16,777,216 は
 * 「the system can only handle 15728640. We do it this way to match ODBC.」として
 * 原典自身が切り下げている（`20260801-lob-batch-retrieval-research`）。
 */
describe("clampLobThreshold", () => {
  it("未指定は 0（常にロケーター）", () => {
    expect(clampLobThreshold(undefined)).toBe(0);
  });

  it("0 以下は 0（負の値で上げられない）", () => {
    expect(clampLobThreshold(0)).toBe(0);
    expect(clampLobThreshold(-1)).toBe(0);
  });

  it("非有限は 0 に倒す（安全側。化けた値を 0x3822 に載せない）", () => {
    expect(clampLobThreshold(Number.NaN)).toBe(0);
    // Infinity を「上限いっぱい」と解釈しない——**上げる方へ倒すと静かにメモリを食う**。
    // 意図しない値が来たときは常にロケーター側へ落とす
    expect(clampLobThreshold(Number.POSITIVE_INFINITY)).toBe(0);
  });

  it("範囲内はそのまま（原典の既定 32,768 も含む）", () => {
    expect(clampLobThreshold(32_768)).toBe(32_768);
    expect(clampLobThreshold(1)).toBe(1);
  });

  it("小数は切り捨てる（uint32 に載せるため）", () => {
    expect(clampLobThreshold(100.9)).toBe(100);
  });

  it("上限 15,728,640 で頭打ち（公表の 16,777,216 は通らない）", () => {
    expect(clampLobThreshold(15_728_640)).toBe(15_728_640);
    expect(clampLobThreshold(16_777_216)).toBe(15_728_640);
  });
});
