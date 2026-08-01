import { describe, it, expect } from "vitest";
import { ScreenBuffer } from "../src/screen/buffer.js";
import type { ParsedWindow } from "../src/protocol/wdsf-parser.js";

/**
 * **窓を出したら、その下の画面は消える。消した下地は取っておかない。**
 *
 * 消すのが表示装置の仕事であることは実機で確認した。実機の `TESTLIB/GRIDCL5`
 * （背景いっぱいに文字を書いてから窓を出す画面）で受信バイトを見ると、
 * 背景を書いた WTD のあと、窓の WTD は
 * `SBA(8,24)` → CREATE WINDOW → `SBA(10,28)` 窓の中身、しか送ってこない。
 * やらないと**窓の中に背景が透ける**（利用者からの報告と同じ症状。修正前の実測では
 * 窓の中に `BACKGROUND-BACKGROUND-...` が残っていた）。
 *
 * **戻すのはホストの仕事**。`TESTLIB/GRIDCL7`（背景 → 窓 → 窓を閉じる）で見ると:
 *   窓を出す前 : `ESC 0x02` SAVE SCREEN
 *   窓を閉じる時: `ESC 0x12` RESTORE SCREEN ＋ 背景 22 行を丸ごと書き直し（1028 バイト）
 *                 → WDSF `d9 5f`（全 GUI 構造体の除去）→ 新しい内容
 * つまりホストが画面を送り直す。こちらで下地を持って戻すと、ホストが書き直した
 * 内容を古い下地で上書きしかねない。
 */
describe("窓の下地", () => {
  /** 実機 GRIDCL5 と同じ窓: SBA(8,24)・深さ 8・幅 30 */
  const parsed: ParsedWindow = { width: 30, height: 8, restrictCursor: true, pulldown: false };
  const WIN_ROW = 8;
  const WIN_COL = 24;

  /** 画面いっぱいに `X` を書く */
  function filled(): ScreenBuffer {
    const buf = new ScreenBuffer();
    for (let addr = 0; addr < buf.size; addr++) buf.setChar(addr, "X");
    return buf;
  }
  const charAt = (buf: ScreenBuffer, row: number, col: number): string => {
    const c = buf.cellAt(buf.addrOf(row, col));
    return c === null ? " " : c.type === "char" ? c.char : "@";
  };

  it("窓が占める範囲を空白にする", () => {
    const buf = filled();
    buf.addWindow(parsed, WIN_ROW, WIN_COL);
    // 枠の矩形（行 8〜17 / 桁 25〜58）＋ 枠の属性が入る桁 24
    expect(charAt(buf, 8, 24)).toBe(" ");
    expect(charAt(buf, 8, 58)).toBe(" ");
    expect(charAt(buf, 17, 24)).toBe(" ");
    expect(charAt(buf, 17, 58)).toBe(" ");
    expect(charAt(buf, 12, 40)).toBe(" "); // 中ほど
  });

  it("窓の外は消さない", () => {
    const buf = filled();
    buf.addWindow(parsed, WIN_ROW, WIN_COL);
    expect(charAt(buf, 7, 40)).toBe("X"); // 1 行上
    expect(charAt(buf, 18, 40)).toBe("X"); // 1 行下
    expect(charAt(buf, 12, 23)).toBe("X"); // 1 桁左
    expect(charAt(buf, 12, 59)).toBe("X"); // 1 桁右
  });

  /**
   * **窓を閉じてもこちらでは何も戻さない。**
   * 戻すのはホスト（RESTORE SCREEN で画面を送り直す）。ここで古い下地を書き戻すと、
   * ホストが書き直した内容を上書きしてしまう。
   */
  it("窓を閉じてもセルには触らない", () => {
    const buf = filled();
    buf.addWindow(parsed, WIN_ROW, WIN_COL);
    buf.setChar(buf.addrOf(12, 40), "W"); // ホストが窓の中身を書く
    buf.removeWindow(WIN_ROW, WIN_COL);
    expect(charAt(buf, 12, 40)).toBe("W"); // 背景 "X" に戻さない
  });

  it("同じ窓を出し直すと、そのたびに範囲を空白にする", () => {
    const buf = filled();
    buf.addWindow(parsed, WIN_ROW, WIN_COL);
    buf.setChar(buf.addrOf(12, 40), "W");
    buf.addWindow(parsed, WIN_ROW, WIN_COL); // ホストは出し直すたびに送ってくる
    expect(charAt(buf, 12, 40)).toBe(" ");
  });

  it("画面の端をはみ出す窓でも落ちない", () => {
    const buf = filled();
    buf.addWindow({ width: 40, height: 6, restrictCursor: false, pulldown: false }, 22, 70);
    expect(charAt(buf, 23, 75)).toBe(" ");
    expect(charAt(buf, 21, 75)).toBe("X"); // 1 行上は残る
  });
});
