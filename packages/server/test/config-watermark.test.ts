import { describe, it, expect, beforeEach } from "vitest";
import { randomBytes } from "node:crypto";
import { PersonalConfigStore, ServerConfigStore } from "../src/config-store.js";
import { SecretCrypto } from "../src/secret-crypto.js";
import type { AuthUser } from "../src/auth.js";

/**
 * ウォーターマークはセッション設定の**表示だけの項目**。
 * 信頼設定ではないので個人設定にも持てる一方、値は CSS へ渡るため書式を縛る。
 */
const crypto = SecretCrypto.fromEnv("K", { K: randomBytes(32).toString("hex") })!;
const alice: AuthUser = { username: "alice", role: "user" };
const admin: AuthUser = { username: "root", role: "admin" };

describe("ウォーターマーク: 保存と露出", () => {
  let store: PersonalConfigStore;
  beforeEach(() => {
    store = new PersonalConfigStore(
      { systems: [{ id: "s-1", name: "sys", host: "h", owner: "alice" }], sessions: [] },
      crypto
    );
  });

  it("個人設定でも持てる（信頼設定ではない）", () => {
    const s = store.addSession(
      {
        name: "d",
        system: "s-1",
        sessionType: "display",
        watermark: { text: "本番 {system}", opacity: 0.2, size: 30, layout: "tile", angle: -30 }
      },
      alice
    );
    expect(s.watermark).toEqual({
      text: "本番 {system}",
      opacity: 0.2,
      size: 30,
      layout: "tile",
      angle: -30
    });
  });

  it("サーバー設定でも持てる", () => {
    const srv = new ServerConfigStore(
      { systems: [{ id: "sys", name: "sys", host: "h" }], sessions: [] },
      crypto
    );
    const s = srv.addSession(
      { name: "d", system: "sys", sessionType: "display", watermark: { text: "検証" } },
      admin
    );
    expect(s.watermark?.text).toBe("検証");
  });

  it("更新で省略すると消える（オブジェクトごと置き換え）", () => {
    const s = store.addSession(
      { name: "d", system: "s-1", sessionType: "display", watermark: { text: "本番" } },
      alice
    );
    const id = s.ref.replace(/^own:/, "");
    const after = store.updateSession(id, { name: "d", system: "s-1", sessionType: "display" }, alice);
    expect(after.watermark).toBeUndefined();
  });

  it("応答は複製を返す（受け取り側の書き換えがストアへ届かない）", () => {
    const s = store.addSession(
      { name: "d", system: "s-1", sessionType: "display", watermark: { text: "本番" } },
      alice
    );
    s.watermark!.text = "書き換え";
    expect(store.listSessions(alice)[0]!.watermark?.text).toBe("本番");
  });
});

describe("ウォーターマーク: 入力の検証", () => {
  let store: PersonalConfigStore;
  const add = (watermark: unknown): unknown =>
    store.addSession({ name: "d", system: "s-1", sessionType: "display", watermark }, alice);
  beforeEach(() => {
    store = new PersonalConfigStore(
      { systems: [{ id: "s-1", name: "sys", host: "h", owner: "alice" }], sessions: [] },
      crypto
    );
  });

  it("色は #rrggbb 以外を弾く（CSS へそのまま渡る値のため）", () => {
    expect(() => add({ text: "x", color: "red; background: url(http://evil)" })).toThrow();
    expect(() => add({ text: "x", color: "#abc" })).toThrow();
    expect(() => add({ text: "x", color: "#A1b2C3" })).not.toThrow();
  });

  it("空文字の透かしは弾く（描きようがない）", () => {
    expect(() => add({ text: "" })).toThrow();
  });

  it("範囲外の濃さ・大きさ・角度は弾く", () => {
    expect(() => add({ text: "x", opacity: 1.5 })).toThrow();
    expect(() => add({ text: "x", size: 500 })).toThrow();
    expect(() => add({ text: "x", angle: 120 })).toThrow();
  });

  it("未知のキーは弾く（strict）", () => {
    expect(() => add({ text: "x", blink: true })).toThrow();
  });
});
