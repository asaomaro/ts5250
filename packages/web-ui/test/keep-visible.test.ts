import { describe, it, expect } from "vitest";
import { scrollToShow } from "../src/keepVisible.js";

/**
 * 一覧の中で選んでいる項目を見える位置に保つ計算。
 *
 * **描画から切り離した純関数**なので数値で試せる（jsdom では `offsetTop` も
 * `clientHeight` も 0 になり、コンポーネントのままでは確かめられない）。
 */
const view = (scrollTop: number, height = 100) => ({ scrollTop, height });
const item = (top: number, height = 20) => ({ top, height });

describe("選んでいる項目を見せる", () => {
  it("収まっていれば動かさない（読んでいる途中で勝手に動かない）", () => {
    expect(scrollToShow(view(0), item(0))).toBe(0);
    expect(scrollToShow(view(0), item(40))).toBe(0);
    expect(scrollToShow(view(50), item(60))).toBe(50);
  });

  it("上にはみ出したら項目の上端に合わせる", () => {
    expect(scrollToShow(view(50), item(20))).toBe(20);
  });

  it("下にはみ出したら項目の下端に合わせる", () => {
    // 上端 100・高さ 20 → 下端 120。枠 100 なので 20 まで送る
    expect(scrollToShow(view(0), item(100))).toBe(20);
  });

  it("先頭へ戻ると先頭が見える（↑↓ の巻き戻し）", () => {
    expect(scrollToShow(view(200), item(0))).toBe(0);
  });

  it("末尾へ飛んでも収まる", () => {
    expect(scrollToShow(view(0), item(380))).toBe(300);
  });

  /** 下端に合わせると先頭が切れて、何の項目か読めなくなる */
  it("枠より高い項目は**上端**に寄せる", () => {
    expect(scrollToShow(view(0), item(50, 200))).toBe(50);
  });

  it("ちょうど収まる境目では動かさない", () => {
    // 上端 80・高さ 20 → 下端 100 は枠ちょうど
    expect(scrollToShow(view(0), item(80))).toBe(0);
  });
});
