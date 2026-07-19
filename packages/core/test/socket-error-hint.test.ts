import { describe, it, expect } from "vitest";
import { describeSocketError, withSocketHint } from "../src/errors.js";

/**
 * OS のエラーコードだけでは「自分の設定が悪いのか、相手が落ちているのか」が分からない。
 * 次に何を確かめればよいかまで書く。
 */
describe("ソケットエラーの説明", () => {
  it("到達不能は経路・停止の可能性を示す", () => {
    expect(describeSocketError("EHOSTUNREACH")).toContain("到達できません");
    expect(describeSocketError("ENETUNREACH")).toContain("到達できません");
  });

  it("応答なしは設定とファイアウォールを示す", () => {
    expect(describeSocketError("ETIMEDOUT")).toContain("ファイアウォール");
  });

  it("拒否はサーバー未起動を示す", () => {
    expect(describeSocketError("ECONNREFUSED")).toContain("動いていない");
  });

  it("名前解決の失敗は DNS を示す", () => {
    expect(describeSocketError("ENOTFOUND")).toContain("DNS");
    expect(describeSocketError("EAI_AGAIN")).toContain("DNS");
  });

  it("切断は TLS の要否を示す（平文ポートへ TLS で繋ぐ誤りが多い）", () => {
    expect(describeSocketError("ECONNRESET")).toContain("TLS");
  });

  it("知らないコードには説明を付けない（嘘を足さない）", () => {
    expect(describeSocketError("EWHATEVER")).toBeUndefined();
    expect(describeSocketError(undefined)).toBeUndefined();
  });
});

describe("説明の付与", () => {
  it("既知のコードなら元の文言に続けて説明を足す", () => {
    const m = withSocketHint("connect failed (h:9476): connect EHOSTUNREACH", "EHOSTUNREACH");
    expect(m).toContain("connect failed (h:9476)");
    expect(m).toContain("到達できません");
  });

  it("未知のコードなら元の文言のまま", () => {
    expect(withSocketHint("boom", "EWHATEVER")).toBe("boom");
  });
});
