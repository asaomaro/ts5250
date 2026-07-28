import { describe, it, expect } from "vitest";
import type { ScreenSnapshot, Session5250 } from "@as400web/core";
import { ScreenRecorder } from "../src/screen-recorder.js";

/**
 * 画面履歴のリングバッファ。
 *
 * ここで固めるのは「記録が漏れず・溜まりすぎず・止めたら止まる」こと。
 * とくに**停止と切断で購読を外す**のは重要——外し忘れるとセッションを捨てても
 * リスナが `Session5250` に残り、バッファごとメモリに居座る。
 */

/** `Session5250` の代わり（`on`/`off`/`snapshot` だけ使う）。購読数を数えられるようにする */
class FakeSession {
  readonly listeners = new Set<(s: ScreenSnapshot) => void>();
  private current = 0;

  on(_e: "screen", fn: (s: ScreenSnapshot) => void): this {
    this.listeners.add(fn);
    return this;
  }
  off(_e: "screen", fn: (s: ScreenSnapshot) => void): this {
    this.listeners.delete(fn);
    return this;
  }
  snapshot(): ScreenSnapshot {
    return { sessionId: "s", rows: 24, cols: 80, cursor: { row: 1, col: this.current }, keyboardLocked: false, cells: [], fields: [] } as unknown as ScreenSnapshot;
  }
  /** ホストから画面が届いた体で 1 コマ流す */
  push(): void {
    this.current += 1;
    for (const fn of this.listeners) fn(this.snapshot());
  }
}

const make = (limit = 100): { s: FakeSession; r: ScreenRecorder } => {
  const s = new FakeSession();
  let t = 0;
  const r = new ScreenRecorder(s as unknown as Session5250, limit, () => (t += 1000));
  return { s, r };
};

describe("ScreenRecorder", () => {
  it("start するまで購読しない（頼まれるまで記録しない）", () => {
    const { s, r } = make();
    expect(r.recording).toBe(false);
    expect(s.listeners.size).toBe(0);
    s.push();
    expect(r.count).toBe(0);
  });

  /** 「何をする前の画面か」が無いと、以降の遷移が何から始まったのか読めない */
  it("start で開始時点の画面を 1 コマ目として入れる", () => {
    const { r } = make();
    r.start();
    expect(r.count).toBe(1);
    expect(r.recording).toBe(true);
  });

  it("画面更新のたびにコマが増える", () => {
    const { s, r } = make();
    r.start();
    s.push();
    s.push();
    expect(r.count).toBe(3); // 開始時 + 2
  });

  it("二重 start で購読を増やさない（同じ画面が 2 回積まれない）", () => {
    const { s, r } = make();
    r.start();
    r.start();
    expect(s.listeners.size).toBe(1);
    s.push();
    expect(r.count).toBe(2); // 開始時 1 + 更新 1（二重に積まれない）
  });

  /** 外し忘れるとセッションを捨ててもリスナが残り、バッファごと居座る */
  it("stop で購読を外す（リークしない）", () => {
    const { s, r } = make();
    r.start();
    expect(s.listeners.size).toBe(1);
    r.stop();
    expect(s.listeners.size).toBe(0);
    expect(r.recording).toBe(false);
  });

  it("stop してもコマは捨てない（止めてから取り出せる）", () => {
    const { s, r } = make();
    r.start();
    s.push();
    r.stop();
    expect(r.count).toBe(2);
    expect(r.snapshotFrames()).toHaveLength(2);
  });

  it("stop 後は記録が増えない", () => {
    const { s, r } = make();
    r.start();
    r.stop();
    s.push();
    expect(r.count).toBe(1);
  });

  it("上限を超えたら古いコマから捨てる", () => {
    const { s, r } = make(3);
    r.start(); // 1 コマ目
    for (let i = 0; i < 5; i++) s.push();
    expect(r.count).toBe(3);
    // 開始時（col=0）＋更新 5 回（1..5）の計 6 コマのうち、新しい 3 つだけが残る
    expect(r.snapshotFrames().map((f) => f.screen.cursor.col)).toEqual([3, 4, 5]);
  });

  it("送信キーを次のコマに添える", () => {
    const { s, r } = make();
    r.start();
    r.noteKey("Enter");
    s.push();
    const frames = r.snapshotFrames();
    expect(frames[0]!.key).toBeUndefined(); // 開始時の画面には操作が無い
    expect(frames[1]!.key).toBe("Enter");
  });

  it("キーは 1 コマ限り（次のコマへ持ち越さない）", () => {
    const { s, r } = make();
    r.start();
    r.noteKey("F3");
    s.push();
    s.push();
    expect(r.snapshotFrames()[2]!.key).toBeUndefined();
  });

  it("記録していないときの noteKey は無視する（止めた後の操作が混ざらない）", () => {
    const { s, r } = make();
    r.noteKey("Enter");
    r.start();
    s.push();
    expect(r.snapshotFrames().every((f) => f.key === undefined)).toBe(true);
  });

  it("clear でコマを捨てる（記録は続く）", () => {
    const { s, r } = make();
    r.start();
    s.push();
    r.clear();
    expect(r.count).toBe(0);
    s.push();
    expect(r.count).toBe(1); // 購読は生きている
  });

  it("各コマに記録時刻が入る", () => {
    const { r } = make();
    r.start();
    expect(r.snapshotFrames()[0]!.capturedAt).toBe(new Date(1000).toISOString());
  });
});
