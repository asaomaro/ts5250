import { describe, it, expect } from "vitest";
import { ScreenBuffer } from "../src/screen/buffer.js";
import type { ParsedWindow } from "../src/protocol/wdsf-parser.js";

/**
 * **窓を出したら、その下の画面は消える。**
 *
 * ホストは窓の下地を消す指示を**送ってこない**。実機の `TESTLIB/GRIDCL5`
 * （背景いっぱいに文字を書いてから窓を出す画面）で受信バイトを見ると、
 * 背景を書いた WTD のあと、窓の WTD は
 * `SBA(8,24)` → CREATE WINDOW → `SBA(10,28)` 窓の中身、しか送ってこない。
 * つまり下地を消すのは表示装置の仕事で、やらないと**窓の中に背景が透ける**
 * （利用者からの報告と同じ症状。修正前の実測では窓の中に
 * `BACKGROUND-BACKGROUND-...` が残っていた）。
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

  it("窓を閉じると下の画面が戻る", () => {
    const buf = filled();
    buf.addWindow(parsed, WIN_ROW, WIN_COL);
    expect(charAt(buf, 12, 40)).toBe(" ");
    buf.removeWindow(WIN_ROW, WIN_COL);
    expect(charAt(buf, 12, 40)).toBe("X");
  });

  /**
   * ホストは同じ窓を出し直すたびに CREATE WINDOW を送ってくる。
   * 下地を窓 id で持つと、2 回目に「窓の中身」を下地として保存してしまい、
   * 閉じたときに背景ではなく窓の中身が戻る。位置で持つのはそのため。
   */
  it("同じ窓を出し直しても下地は最初の画面のまま", () => {
    const buf = filled();
    buf.addWindow(parsed, WIN_ROW, WIN_COL);
    buf.setChar(buf.addrOf(12, 40), "W"); // 窓の中身をホストが書く
    buf.addWindow(parsed, WIN_ROW, WIN_COL); // 出し直し
    buf.removeWindow(WIN_ROW, WIN_COL);
    expect(charAt(buf, 12, 40)).toBe("X"); // 窓の中身 "W" ではなく元の背景
  });

  it("大きさが変わった窓に出し直しても、前の下地を戻してから消す", () => {
    const buf = filled();
    buf.addWindow(parsed, WIN_ROW, WIN_COL);
    buf.addWindow({ ...parsed, width: 10, height: 2 }, WIN_ROW, WIN_COL);
    // 小さい窓の外に出た桁は背景が戻っている
    expect(charAt(buf, 12, 40)).toBe("X");
    expect(charAt(buf, 8, 30)).toBe(" "); // 小さい窓の中は空白
  });

  it("画面クリアで下地も捨てる（戻す先が無い）", () => {
    const buf = filled();
    buf.addWindow(parsed, WIN_ROW, WIN_COL);
    buf.clearUnit();
    buf.removeWindow(WIN_ROW, WIN_COL);
    expect(charAt(buf, 12, 40)).toBe(" "); // クリア後なので空白のまま
  });

  it("SAVE / RESTORE SCREEN を挟んでも下地は戻る", () => {
    const buf = filled();
    buf.addWindow(parsed, WIN_ROW, WIN_COL);
    buf.saveScreen();
    buf.clearUnit();
    expect(buf.restoreScreen()).toBe(true);
    buf.removeWindow(WIN_ROW, WIN_COL);
    expect(charAt(buf, 12, 40)).toBe("X");
  });

  it("画面の端をはみ出す窓でも落ちない", () => {
    const buf = filled();
    buf.addWindow({ width: 40, height: 6, restrictCursor: false, pulldown: false }, 22, 70);
    expect(charAt(buf, 23, 75)).toBe(" ");
    expect(charAt(buf, 21, 75)).toBe("X"); // 1 行上は残る
  });
});
