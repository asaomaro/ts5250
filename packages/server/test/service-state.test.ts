import { describe, it, expect } from "vitest";
import { holdsConnection, autoStartOf, type ServiceState } from "../src/service-state.js";

/**
 * 待ち受けの状態（`20260801-service-lifecycle-model`）。
 *
 * プリンターと待ち行列監視が**同じ語彙**を使うための土台。
 * 別々の文字列を持たせると同じことを表す語が 2 つになり、UI が二重になる。
 */
describe("holdsConnection", () => {
  it("待ち受け中と再接続中は接続を持つ", () => {
    expect(holdsConnection("listening")).toBe(true);
    // **張り直している最中も資源を握っている**（枠を数えるときに落とさない）
    expect(holdsConnection("reconnecting")).toBe(true);
  });

  it("停止中と障害は接続を持たない", () => {
    // 停止は装置を手放す——掴んだまま受け取らないと他の人が使えない
    expect(holdsConnection("stopped")).toBe(false);
    // 待っても直らないと判断した時点で握らない
    expect(holdsConnection("error")).toBe(false);
  });

  it("4 状態がすべて分類される（増えたら落ちる）", () => {
    const all: ServiceState[] = ["stopped", "listening", "reconnecting", "error"];
    expect(all.map(holdsConnection)).toEqual([false, true, true, false]);
  });
});

describe("autoStartOf", () => {
  it("未設定は true（いまある定義の挙動を変えない）", () => {
    expect(autoStartOf(undefined)).toBe(true);
  });

  it("明示的な false だけが待ち受けを保留する", () => {
    expect(autoStartOf(false)).toBe(false);
    expect(autoStartOf(true)).toBe(true);
  });
});
