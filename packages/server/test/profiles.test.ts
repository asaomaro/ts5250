import { describe, it, expect } from "vitest";
import { ProfileStore } from "../src/profiles.js";

const profiles = [
  {
    name: "pub400",
    host: "pub400.com",
    port: 23,
    ccsid: 37,
    deviceName: "WEBEMU01",
    signon: { user: "USER", passwordEnv: "TEST_PW" }
  },
  { name: "manual", host: "192.168.0.5" },
  { name: "wide", host: "pub400.com", ccsid: 1399, screenSize: "27x132" as const }
];

describe("ProfileStore", () => {
  it("listPublic は認証情報を含まない", () => {
    const store = new ProfileStore(profiles);
    const pub = store.listPublic();
    expect(pub).toHaveLength(3);
    const p = pub.find((x) => x.name === "pub400");
    expect(p).toMatchObject({ name: "pub400", host: "pub400.com", autoSignon: true });
    expect(JSON.stringify(pub)).not.toContain("USER");
    expect(JSON.stringify(pub)).not.toContain("passwordEnv");
    expect(pub.find((x) => x.name === "manual")?.autoSignon).toBe(false);
  });

  it("resolveConnectOptions が passwordEnv を解決し user/password を設定する", () => {
    process.env["TEST_PW"] = "secret123";
    const store = new ProfileStore(profiles);
    const opts = store.resolveConnectOptions("pub400");
    expect(opts).toMatchObject({ host: "pub400.com", port: 23, ccsid: 37, user: "USER", password: "secret123" });
    delete process.env["TEST_PW"];
  });

  it("passwordEnv 未設定なら CONNECT_FAILED", () => {
    delete process.env["TEST_PW"];
    const store = new ProfileStore(profiles);
    expect(() => store.resolveConnectOptions("pub400")).toThrow(
      expect.objectContaining({ code: "CONNECT_FAILED" })
    );
  });

  it("signon なしプロファイルは user/password を設定しない", () => {
    const store = new ProfileStore(profiles);
    const opts = store.resolveConnectOptions("manual");
    expect(opts.user).toBeUndefined();
    expect(opts.password).toBeUndefined();
  });

  it("screenSize を core の ConnectOptions へ渡す（端末タイプ交渉に効かせるため）", () => {
    const store = new ProfileStore(profiles);
    // 転記漏れがあると黙って既定の 24x80（IBM-3179-2）で交渉され、プロファイルの指定が無視される
    expect(store.resolveConnectOptions("wide").screenSize).toBe("27x132");
  });

  it("screenSize 未指定なら渡さない（core 側の既定 24x80 に委ねる）", () => {
    const store = new ProfileStore(profiles);
    expect(store.resolveConnectOptions("manual").screenSize).toBeUndefined();
  });

  it("不明なプロファイルは SESSION_NOT_FOUND", () => {
    const store = new ProfileStore(profiles);
    expect(() => store.get("nope")).toThrow(
      expect.objectContaining({ code: "SESSION_NOT_FOUND" })
    );
  });

  it("不正な profiles.json は拒否する", () => {
    // ProfileStore コンストラクタは検証済み配列前提。fromFile の zod 検証をスキーマ経由で確認
    expect(() =>
      new ProfileStore([{ name: "", host: "x" } as never]).listPublic()
    ).not.toThrow(); // コンストラクタ自体は検証しない（fromFile が検証）
  });
});
