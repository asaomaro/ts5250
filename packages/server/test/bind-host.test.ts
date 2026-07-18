import { describe, it, expect } from "vitest";
import { resolveBindHost, isLoopback } from "../src/bind-host.js";

/**
 * 認証オフは「単一の信頼ユーザー」前提（canEditProfiles 全通過・assertProfileAccess 素通し）なので、
 * その状態を LAN に晒さない。既定でループバックに束縛する。
 */
describe("resolveBindHost", () => {
  it("認証オフ・未指定ならループバックのみ", () => {
    expect(resolveBindHost(undefined, false)).toEqual({ host: "127.0.0.1" });
  });

  it("認証オン・未指定なら従来どおり全インターフェース", () => {
    expect(resolveBindHost(undefined, true)).toEqual({ host: "0.0.0.0" });
  });

  it("--host は認証状態に関わらず尊重する", () => {
    expect(resolveBindHost("0.0.0.0", true).host).toBe("0.0.0.0");
    expect(resolveBindHost("192.168.1.10", true).host).toBe("192.168.1.10");
  });

  it("認証オフのまま外部公開すると警告する（起動は止めない）", () => {
    const r = resolveBindHost("0.0.0.0", false);
    expect(r.host).toBe("0.0.0.0");
    expect(r.warn).toMatch(/認証なし/);
    expect(r.warn).toMatch(/--users/);
  });

  it("認証オフでもループバック明示なら警告しない", () => {
    expect(resolveBindHost("127.0.0.1", false).warn).toBeUndefined();
    expect(resolveBindHost("localhost", false).warn).toBeUndefined();
    expect(resolveBindHost("::1", false).warn).toBeUndefined();
  });
});

describe("isLoopback", () => {
  it("ループバックを判定する", () => {
    for (const h of ["127.0.0.1", "127.1.2.3", "localhost", "LOCALHOST", "::1", "[::1]"]) {
      expect(isLoopback(h)).toBe(true);
    }
  });
  it("それ以外は false", () => {
    for (const h of ["0.0.0.0", "192.168.1.10", "10.0.0.1", "example.com", "::"]) {
      expect(isLoopback(h)).toBe(false);
    }
  });
});
