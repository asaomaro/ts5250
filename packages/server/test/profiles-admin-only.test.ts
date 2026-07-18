import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProfileStore } from "../src/profiles.js";
import { assertProfileAccess, type AuthUser } from "../src/auth.js";

/**
 * サーバー設定（profiles）は信頼設定の置き場なので、認証オンでは admin 専用。
 * 一覧から隠すだけ（obscurity）にせず、profile 名を名指しした解決も塞ぐことを確認する。
 */
const ADMIN: AuthUser = { username: "root", role: "admin" };
const USER: AuthUser = { username: "alice", role: "user" };

function store(): ProfileStore {
  const dir = mkdtempSync(join(tmpdir(), "padm-"));
  const path = join(dir, "profiles.json");
  writeFileSync(
    path,
    JSON.stringify({
      profiles: [
        {
          name: "pub400",
          host: "pub400.com",
          sessionType: "printer",
          printer: { autoPdfDir: "/var/spool/out" }
        }
      ]
    })
  );
  return ProfileStore.fromFile(path);
}

describe("サーバー設定の認可（admin 限定）", () => {
  describe("assertProfileAccess", () => {
    it("認証オフ（undefined）は通す", () => {
      expect(() => assertProfileAccess(undefined)).not.toThrow();
    });
    it("admin は通す", () => {
      expect(() => assertProfileAccess(ADMIN)).not.toThrow();
    });
    it("一般ユーザーは FORBIDDEN", () => {
      expect(() => assertProfileAccess(USER)).toThrow(/forbidden/i);
    });
  });

  describe("listForUser（一覧）", () => {
    it("認証オフ・admin には全件返す", () => {
      const s = store();
      expect(s.listForUser(undefined)).toHaveLength(1);
      expect(s.listForUser(ADMIN)).toHaveLength(1);
    });
    it("一般ユーザーには空配列（存在ごと見せない）", () => {
      expect(store().listForUser(USER)).toEqual([]);
    });
  });

  describe("名指しの解決（obscurity に頼らない）", () => {
    it("一般ユーザーは profile 名を知っていても接続解決できない", () => {
      expect(() => store().resolveConnectOptions("pub400", USER)).toThrow(/forbidden/i);
    });

    it("一般ユーザーはプリンター出力設定も解決できない", () => {
      expect(() => store().resolvePrinterOutput("pub400", USER)).toThrow(/forbidden/i);
    });

    it("存在しない名前でも一般ユーザーには FORBIDDEN（存在の有無を漏らさない）", () => {
      expect(() => store().resolveConnectOptions("no-such-profile", USER)).toThrow(/forbidden/i);
    });

    it("admin と認証オフは従来どおり解決できる", () => {
      const s = store();
      expect(s.resolveConnectOptions("pub400", ADMIN).host).toBe("pub400.com");
      expect(s.resolveConnectOptions("pub400", undefined).host).toBe("pub400.com");
      expect(s.resolvePrinterOutput("pub400", ADMIN)?.autoPdfDir).toBe("/var/spool/out");
    });
  });
});
