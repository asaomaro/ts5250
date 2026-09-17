import { describe, it, expect } from "vitest";
import { ScreenBuffer } from "../src/screen/buffer.js";
import type { ParsedWindow } from "../src/protocol/wdsf-parser.js";

/**
 * 窓（CREATE WINDOW）の中で属性が閉じられずに窓の行末へ達すると、`fields` に載らない
 * 表示専用の窓の中身（ヘルプ等）では境界がどこにも無く、アドレス順の一続きスキャンが
 * そのまま窓の外（同じ行の右側・次行の左側＝背面の画面）まで下線・色を引きずってしまう
 * 不具合の回帰（利用者報告: SEU で F4 窓を開いた状態で F1 ヘルプ窓を開くと、
 * 窓の外のソース行に元々無かった下線が表示される）。
 *
 * ACS（`PS5250.propagateAttribute()`）はフィールド境界（＝属性バイトの実在位置）でしか
 * 打ち切らないが、窓の中身は実機でも独自の属性バイトを伴って描かれるため窓の外へは
 * 漏れない。当プロジェクトは `fields`（入力欄）以外に境界情報を持たないため、窓の矩形の
 * 右端を `snapshot()` の打ち切り位置に加えて同じ効果を得る（`field-attr-bound.test.ts` と
 * 同じ ACS 準拠の境界付けを窓にも適用）。
 */
describe("窓の中の属性境界（ACS 準拠）", () => {
  const parsed: ParsedWindow = { width: 20, height: 3, restrictCursor: false, pulldown: false };
  const WIN_ROW = 5;
  const WIN_COL = 10;
  // blankWindowArea と同じ矩形: 行 5〜9（5+3+1）/ 桁 10〜34（10+20+4）

  it("窓の行末で閉じ属性が無くても、窓の外（同じ行の右側）へ下線が漏れない", () => {
    const buf = new ScreenBuffer();
    buf.addWindow(parsed, WIN_ROW, WIN_COL);
    // 窓の中の行（7）の右端寄りに下線属性を置き、閉じ属性を送らないまま窓の右端(34)まで書く
    buf.setAttr(buf.addrOf(7, 30), 0x24); // 緑下線
    buf.setChar(buf.addrOf(7, 31), "A");
    buf.setChar(buf.addrOf(7, 34), "B"); // 窓の最終桁（閉じ属性なし）
    const row = buf.snapshot("t", false).cells[6]!; // row7 = index6
    expect(row[30]!.underline).toBe(true); // 'A' col31 は窓の中
    expect(row[34]!.underline).toBe(false); // col35（窓の外・右）に漏れない
    expect(row[50]!.underline).toBe(false); // 遠い桁も漏れない
  });

  it("窓の行末で閉じ属性が無くても、次の行の窓の外（左側）へ下線が漏れない", () => {
    const buf = new ScreenBuffer();
    buf.addWindow(parsed, WIN_ROW, WIN_COL);
    buf.setAttr(buf.addrOf(7, 30), 0x24);
    buf.setChar(buf.addrOf(7, 34), "B"); // 窓の最終桁（閉じ属性なし）
    const snap = buf.snapshot("t", false);
    // row8 はまだ窓の範囲内の行（5〜9）——窓の外＝左側（桁1〜9）に漏れないこと
    const row8 = snap.cells[7]!;
    expect(row8[0]!.underline).toBe(false);
    expect(row8[8]!.underline).toBe(false);
    // row10 は窓の外（下）——完全に背面。ここにも漏れないこと（利用者報告の症状そのもの）
    const row10 = snap.cells[9]!;
    expect(row10[0]!.underline).toBe(false);
    expect(row10[20]!.underline).toBe(false);
  });

  /**
   * **左端も打ち切る。** 窓を開くと `blankWindowArea` が矩形のセルを消すので、背面の欄の
   * 閉じ属性が窓の中にあると一緒に消え、窓の左側で始まった属性が窓の中を突き抜ける
   * （実機 YB0140R の窓を PDM 一覧の上で PageUp すると、OPT 欄の下線が窓の全幅に伸びた。
   * ACS は 2〜3 桁のまま。RESTORE SCREEN の書き戻しでは `retainedEnds` も残らない）。
   */
  it("窓の左側で始まった下線の閉じ属性が窓に消されても、窓の中へ伸びない", () => {
    const buf = new ScreenBuffer();
    buf.setAttr(buf.addrOf(7, 5), 0x24); // 背面の欄の下線（窓の左側で始まる）
    buf.setChar(buf.addrOf(7, 6), "1");
    buf.setAttr(buf.addrOf(7, 12), 0x20); // 閉じ属性（窓の矩形の中＝窓を開くと消える）
    buf.addWindow(parsed, WIN_ROW, WIN_COL);
    buf.setChar(buf.addrOf(7, 20), "W"); // 窓の中身（属性を伴わない表示専用テキスト）
    const row = buf.snapshot("t", false).cells[6]!; // row7 = index6
    expect(row[5]!.underline).toBe(true); // 窓の左側（背面の欄）は下線のまま
    expect(row[8]!.underline).toBe(true);
    expect(row[9]!.underline).toBe(false); // 窓の左端（col10）から打ち切る
    expect(row[19]!.underline).toBe(false); // 'W'
    expect(row[34]!.underline).toBe(false);
  });

  it("窓が無ければ従来どおり行をまたいで下線が続く（回帰させない）", () => {
    const buf = new ScreenBuffer();
    buf.setAttr(buf.addrOf(1, 78), 0x24); // 1 行目の末尾近くで下線を開始（閉じ属性なし）
    buf.setChar(buf.addrOf(1, 79), "A");
    buf.setChar(buf.addrOf(2, 1), "B"); // 2 行目の先頭（窓が無いので境界なし）
    const snap = buf.snapshot("t", false);
    expect(snap.cells[0]![78]!.underline).toBe(true); // 'A'
    expect(snap.cells[1]![0]!.underline).toBe(true); // 'B'（従来どおり引き継ぐ）
  });
});
