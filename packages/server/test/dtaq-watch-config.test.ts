/**
 * 監視セッション（`dtaqwatch`）の設定スキーマ（`20260723-dtaq-watch-notify`）。
 */
import { describe, it, expect } from "vitest";
import { personalSessionSchema } from "../src/config-types.js";
import { PersonalConfigStore } from "../src/config-store.js";

describe("dtaqwatch セッションのスキーマ", () => {
  const base = { id: "w", name: "n", system: "s" };
  const spec = { library: "MYLIB", name: "ORDERQ" };

  it("dtaqwatch ＋ dtaqWatch は通る", () => {
    const r = personalSessionSchema.safeParse({ ...base, sessionType: "dtaqwatch", dtaqWatch: spec });
    expect(r.success).toBe(true);
  });

  it("**dtaqwatch なのに dtaqWatch が無いと弾く**", () => {
    const r = personalSessionSchema.safeParse({ ...base, sessionType: "dtaqwatch" });
    expect(r.success).toBe(false);
  });

  it("**display なのに dtaqWatch があると弾く**", () => {
    const r = personalSessionSchema.safeParse({ ...base, sessionType: "display", dtaqWatch: spec });
    expect(r.success).toBe(false);
  });

  it("printer でも同じく弾く", () => {
    const r = personalSessionSchema.safeParse({ ...base, sessionType: "printer", dtaqWatch: spec });
    expect(r.success).toBe(false);
  });

  it("未知のキーは .strict() で弾く", () => {
    const r = personalSessionSchema.safeParse({
      ...base,
      sessionType: "dtaqwatch",
      dtaqWatch: { ...spec, bogus: 1 }
    });
    expect(r.success).toBe(false);
  });

  it("ライブラリー・キュー名は 10 文字まで（EBCDIC 固定長）", () => {
    const ok = personalSessionSchema.safeParse({
      ...base,
      sessionType: "dtaqwatch",
      dtaqWatch: { library: "A".repeat(10), name: "B".repeat(10) }
    });
    expect(ok.success).toBe(true);
    const ng = personalSessionSchema.safeParse({
      ...base,
      sessionType: "dtaqwatch",
      dtaqWatch: { library: "A".repeat(11), name: "B" }
    });
    expect(ng.success).toBe(false);
  });

  it("API 応答（listSessions）に dtaqWatch が出る", () => {
    const store = new PersonalConfigStore({
      systems: [{ id: "s", name: "s", host: "h" }],
      sessions: [{ id: "w", name: "n", system: "s", sessionType: "dtaqwatch", dtaqWatch: spec }]
    });
    expect(store.listSessions(undefined)[0]?.dtaqWatch).toEqual(spec);
  });
});
