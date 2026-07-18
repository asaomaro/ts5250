import { describe, it, expect } from "vitest";
import {
  hashPassword,
  verifyPasswordHash,
  hashToken,
  UserStore,
  SessionStore,
  assertOwner
} from "../src/auth.js";

describe("auth: パスワードハッシュ", () => {
  it("scrypt でハッシュし、正しいパスワードのみ検証が通る", () => {
    const h = hashPassword("s3cret!");
    expect(h).toMatch(/^[0-9a-f]+:[0-9a-f]+$/);
    expect(verifyPasswordHash("s3cret!", h)).toBe(true);
    expect(verifyPasswordHash("wrong", h)).toBe(false);
  });
  it("壊れたハッシュ文字列は false", () => {
    expect(verifyPasswordHash("x", "garbage")).toBe(false);
    expect(verifyPasswordHash("x", "")).toBe(false);
  });
});

describe("auth: UserStore", () => {
  const store = new UserStore([
    { username: "admin", role: "admin", passwordHash: hashPassword("adminpw"), tokenHashes: [hashToken("tok-admin")] },
    { username: "alice", role: "user", passwordHash: hashPassword("alicepw"), tokenHashes: [hashToken("tok-alice")] }
  ]);
  it("username/password で AuthUser を返す", () => {
    expect(store.verifyPassword("alice", "alicepw")).toEqual({ username: "alice", role: "user" });
    expect(store.verifyPassword("alice", "bad")).toBeUndefined();
    expect(store.verifyPassword("nobody", "x")).toBeUndefined();
  });
  it("API トークンからユーザーを引ける", () => {
    expect(store.findByToken("tok-admin")).toEqual({ username: "admin", role: "admin" });
    expect(store.findByToken("tok-alice")).toEqual({ username: "alice", role: "user" });
    expect(store.findByToken("tok-unknown")).toBeUndefined();
  });
});

describe("auth: SessionStore", () => {
  it("作成した sid でユーザーを引け、destroy で消える", () => {
    const now = 1000;
    const s = new SessionStore(100, () => now);
    const sid = s.create({ username: "alice", role: "user" });
    expect(s.get(sid)).toEqual({ username: "alice", role: "user" });
    s.destroy(sid);
    expect(s.get(sid)).toBeUndefined();
  });
  it("TTL 超過で失効する", () => {
    let now = 1000;
    const s = new SessionStore(100, () => now);
    const sid = s.create({ username: "alice", role: "user" });
    now = 1101;
    expect(s.get(sid)).toBeUndefined();
  });
});

describe("auth: assertOwner", () => {
  const alice = { username: "alice", role: "user" as const };
  const admin = { username: "root", role: "admin" as const };
  it("認証 OFF（user 未定義）は常に許可", () => {
    expect(() => assertOwner("bob", undefined)).not.toThrow();
  });
  it("所有者一致は許可、不一致は FORBIDDEN", () => {
    expect(() => assertOwner("alice", alice)).not.toThrow();
    expect(() => assertOwner("bob", alice)).toThrowError(/forbidden/);
  });
  it("admin は他人の資源も許可", () => {
    expect(() => assertOwner("bob", admin)).not.toThrow();
  });
});
