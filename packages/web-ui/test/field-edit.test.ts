import { describe, it, expect } from "vitest";
import {
  initEdit,
  editValue,
  typeChar,
  backspace,
  del,
  moveCursor,
  home,
  end,
  toggleInsert,
  paste
} from "../src/composables/fieldEdit.js";

describe("fieldEdit — 上書きモード（5250 既定）", () => {
  it("途中入力は後続をシフトせず置換する", () => {
    let s = initEdit("ABCDE", 5, 1); // cursor at B
    s = typeChar(s, "X");
    expect(editValue(s)).toBe("AXCDE"); // B が X に置換、C 以降そのまま
    expect(s.cursor).toBe(2);
  });

  it("フィールド満杯後の入力はブロックされる（5250: field-exit が必要）", () => {
    let s = initEdit("AB", 3, 2);
    s = typeChar(s, "C");
    expect(editValue(s)).toBe("ABC");
    expect(s.cursor).toBe(3); // 満杯位置
    s = typeChar(s, "D"); // 満杯のためブロック
    expect(editValue(s)).toBe("ABC");
  });
});

describe("fieldEdit — 挿入モード", () => {
  it("Insert トグルで挿入モードになり後続を右シフト（末尾溢れ）", () => {
    let s = initEdit("AB   ", 5, 1);
    s = toggleInsert(s);
    expect(s.insertMode).toBe(true);
    s = typeChar(s, "X");
    expect(editValue(s)).toBe("AXB  "); // B が右へ
  });
});

describe("fieldEdit — バックスペース/Delete", () => {
  it("バックスペースはカーソル左＋左詰め", () => {
    let s = initEdit("ABCDE", 5, 3); // cursor at D
    s = backspace(s);
    expect(editValue(s)).toBe("ABDE "); // C 削除、D 以降左詰め
    expect(s.cursor).toBe(2);
  });

  it("先頭でのバックスペースは無効", () => {
    let s = initEdit("ABC", 3, 0);
    s = backspace(s);
    expect(editValue(s)).toBe("ABC");
    expect(s.cursor).toBe(0);
  });

  it("Delete はカーソル位置削除＋左詰め", () => {
    let s = initEdit("ABCDE", 5, 1);
    s = del(s);
    expect(editValue(s)).toBe("ACDE ");
  });
});

describe("fieldEdit — カーソル移動", () => {
  it("Home/End/矢印", () => {
    let s = initEdit("AB   ", 5, 3);
    s = home(s);
    expect(s.cursor).toBe(0);
    s = end(s);
    expect(s.cursor).toBe(2); // "AB" の次
    s = moveCursor(s, -1);
    expect(s.cursor).toBe(1);
    s = moveCursor(s, 10);
    expect(s.cursor).toBe(5); // 末尾（len）でクランプ
  });

  it("矢印で末尾（len＝最終文字の後ろ）まで到達できる", () => {
    let s = initEdit("ABCDE", 5, 4); // 満杯・最終文字上
    s = moveCursor(s, 1);
    expect(s.cursor).toBe(5); // 末尾に止まれる（1 桁隣の欄外へ出ない）
    s = moveCursor(s, 1);
    expect(s.cursor).toBe(5); // クランプ
  });

  it("満杯欄でも末尾へ移動して Backspace で最終文字を削除できる", () => {
    let s = initEdit("ABCDE", 5, 0); // フルケタ
    s = end(s);
    expect(s.cursor).toBe(5); // End で末尾へ
    s = backspace(s);
    expect(editValue(s)).toBe("ABCD "); // 最終文字 E を削除
    expect(s.cursor).toBe(4);
  });

  it("末尾（len）での Delete は無操作（削除対象が無い）", () => {
    let s = initEdit("ABCDE", 5, 5);
    s = del(s);
    expect(editValue(s)).toBe("ABCDE");
    expect(s.cursor).toBe(5);
  });
});

describe("fieldEdit — paste", () => {
  it("複数文字を上書きモードで順に入力し超過は切り詰め", () => {
    let s = initEdit("     ", 5, 0);
    s = paste(s, "HELLO WORLD");
    expect(editValue(s)).toBe("HELLO"); // フィールド長 5 で切り詰め
  });
});
