import { describe, it, expect } from "vitest";
import { SignonError } from "../src/hostserver/signon.js";
import { classifySignonReturnCode } from "../src/hostserver/return-codes.js";
import { Tn5250Error } from "../src/errors.js";

/**
 * 認証失敗の原因は**型として**公開する。
 * 呼び出し側が文言（変わりうる）ではなく値で分岐できることを担保する。
 */
describe("SignonError", () => {
  const err = new SignonError(classifySignonReturnCode(0x0003000b)!);

  it("Tn5250Error として捕捉できる", () => {
    expect(err).toBeInstanceOf(Tn5250Error);
    expect(err.code).toBe("UNAUTHENTICATED");
  });

  it("戻りコードを型付きで公開する（実機で観測した値）", () => {
    expect(err.rc).toBe(0x0003000b);
  });

  it("分類と再試行可否を公開する", () => {
    expect(err.kind).toBe("password-incorrect");
    expect(err.retryable).toBe(true);
  });

  it("無効化されたプロファイルは retryable にならない", () => {
    const revoked = new SignonError(classifySignonReturnCode(0x00020002)!);
    expect(revoked.kind).toBe("user-revoked");
    expect(revoked.retryable).toBe(false);
  });

  it("メッセージに戻りコードを含む", () => {
    expect(err.message).toContain("0x0003000b");
  });

  it("name を SignonError にする", () => {
    expect(err.name).toBe("SignonError");
  });
});
