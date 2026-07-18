import { describe, it, expect } from "vitest";
import {
  classifySignonReturnCode,
  describeSignonFailure,
  RC_OK
} from "../src/hostserver/return-codes.js";

/**
 * 誤ったパスワードでの検証は実機では行わない（プロファイル無効化のリスク）。
 * 代わりに分類ロジックをここで固定する。
 */
describe("classifySignonReturnCode", () => {
  it("成功は undefined", () => {
    expect(classifySignonReturnCode(RC_OK)).toBeUndefined();
  });

  it("ユーザー ID 不明", () => {
    const f = classifySignonReturnCode(0x00020001)!;
    expect(f.kind).toBe("user-unknown");
    expect(f.retryable).toBe(true);
  });

  it("ユーザー ID 無効化は再試行しても通らない", () => {
    const f = classifySignonReturnCode(0x00020002)!;
    expect(f.kind).toBe("user-revoked");
    expect(f.retryable).toBe(false);
  });

  it("パスワード誤り", () => {
    const f = classifySignonReturnCode(0x0003000b)!;
    expect(f.kind).toBe("password-incorrect");
    expect(f.retryable).toBe(true);
  });

  it("0x0003000C は「次に誤ると無効化」（期限切れではない）", () => {
    const f = classifySignonReturnCode(0x0003000c)!;
    expect(f.kind).toBe("password-last-attempt");
    expect(f.message).toMatch(/次に誤ると/);
    expect(f.message).not.toMatch(/期限切れ/);
  });

  it("0x0003000D は「期限切れ」（次に誤ると無効化ではない）", () => {
    const f = classifySignonReturnCode(0x0003000d)!;
    expect(f.kind).toBe("password-expired");
    expect(f.message).toMatch(/期限切れ/);
    expect(f.message).not.toMatch(/次に誤ると/);
  });

  it("0x0C と 0x0D は別物として扱われる", () => {
    expect(classifySignonReturnCode(0x0003000c)!.kind).not.toBe(
      classifySignonReturnCode(0x0003000d)!.kind
    );
  });

  it("パスワードが *NONE", () => {
    expect(classifySignonReturnCode(0x00030010)!.kind).toBe("password-none");
  });

  it("上位 16 ビットのレンジで分類する", () => {
    expect(classifySignonReturnCode(0x00010042)!.kind).toBe("request-error");
    expect(classifySignonReturnCode(0x00040099)!.kind).toBe("security-error");
    expect(classifySignonReturnCode(0x00060001)!.kind).toBe("token-error");
  });

  it("個別コードがレンジより優先される", () => {
    // 0x0002xxxx はレンジ表に無いが、個別コードは拾える
    expect(classifySignonReturnCode(0x00020001)!.kind).toBe("user-unknown");
  });

  it("未知のコードも情報を落とさず返す", () => {
    const f = classifySignonReturnCode(0x00990099)!;
    expect(f.kind).toBe("unknown");
    expect(f.message).toContain("00990099");
    expect(f.retryable).toBe(false);
  });

  it("負にならない大きな値でも 16 進表記が壊れない", () => {
    expect(classifySignonReturnCode(0xffffffff)!.message).toContain("ffffffff");
  });
});

describe("describeSignonFailure", () => {
  it("戻りコードを 16 進で併記する", () => {
    const f = classifySignonReturnCode(0x0003000b)!;
    expect(describeSignonFailure(f)).toBe("パスワードが誤っています (rc=0x0003000b)");
  });
});

describe("実機で観測した挙動（IBM i 7.5 / PUB400）", () => {
  it("誤ったパスワードは 0x0003000B で retryable", () => {
    const f = classifySignonReturnCode(0x0003000b)!;
    expect(f.kind).toBe("password-incorrect");
    expect(f.retryable).toBe(true);
  });

  it("存在しないユーザー ID も 0x0003000B が返る（ユーザー列挙対策）ため、user-unknown とは別物として扱える", () => {
    // 実機は 0x00020001 を返さなかった。分類自体は他構成のために残してある
    expect(classifySignonReturnCode(0x0003000b)!.kind).toBe("password-incorrect");
    expect(classifySignonReturnCode(0x00020001)!.kind).toBe("user-unknown");
  });
});
