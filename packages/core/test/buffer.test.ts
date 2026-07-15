import { describe, it, expect } from "vitest";
import { ScreenBuffer } from "../src/screen/buffer.js";
import { FFW } from "../src/protocol/constants.js";
import { Tn5250Error } from "../src/errors.js";

const INPUT_FFW = FFW.ID_VALUE; // 入力可・英数
const BYPASS_FFW = FFW.ID_VALUE | FFW.BYPASS;

function writeText(b: ScreenBuffer, row: number, col: number, text: string): void {
  const start = b.addrOf(row, col);
  for (let i = 0; i < text.length; i++) b.setChar(start + i, text[i] as string);
}

describe("ScreenBuffer アドレス変換", () => {
  it("1 始まり row/col ⇔ 線形アドレスが往復する", () => {
    const b = new ScreenBuffer();
    expect(b.addrOf(1, 1)).toBe(0);
    expect(b.addrOf(2, 1)).toBe(80);
    expect(b.addrOf(24, 80)).toBe(24 * 80 - 1);
    expect(b.rowColOf(80)).toEqual({ row: 2, col: 1 });
  });

  it("範囲外は PROTOCOL_ERROR", () => {
    const b = new ScreenBuffer();
    expect(() => b.addrOf(0, 1)).toThrow(Tn5250Error);
    expect(() => b.addrOf(25, 1)).toThrow(Tn5250Error);
    expect(() => b.setChar(24 * 80, "x")).toThrow(Tn5250Error);
  });
});

describe("ScreenBuffer 属性の解決", () => {
  it("属性バイトは次の属性まで有効で、行をまたいで継続する", () => {
    const b = new ScreenBuffer();
    b.setAttr(b.addrOf(1, 78), 0x22); // white
    writeText(b, 1, 79, "AB"); // 行末 2 文字
    writeText(b, 2, 1, "CD"); // 次行に継続
    b.setAttr(b.addrOf(2, 3), 0x28); // red
    writeText(b, 2, 4, "E");
    const s = b.snapshot("s", false);
    expect(s.cells[0]?.[77]?.kind).toBe("attr");
    expect(s.cells[0]?.[78]).toMatchObject({ char: "A", color: "white" });
    expect(s.cells[1]?.[0]).toMatchObject({ char: "C", color: "white" }); // 行またぎ
    expect(s.cells[1]?.[3]).toMatchObject({ char: "E", color: "red" });
  });

  it("underline / reverse / blink / columnSeparator をデコードする", () => {
    const b = new ScreenBuffer();
    b.setAttr(0, 0x26); // white underline
    b.setChar(1, "U");
    b.setAttr(2, 0x29); // red reverse
    b.setChar(3, "R");
    b.setAttr(4, 0x2a); // red blink
    b.setChar(5, "B");
    b.setAttr(6, 0x30); // turquoise column separator
    b.setChar(7, "C");
    const row = b.snapshot("s", false).cells[0];
    expect(row?.[1]).toMatchObject({ underline: true, color: "white" });
    expect(row?.[3]).toMatchObject({ reverse: true, color: "red" });
    expect(row?.[5]).toMatchObject({ blink: true, color: "red" });
    expect(row?.[7]).toMatchObject({ columnSeparator: true, color: "turquoise" });
  });

  it("nonDisplay 属性のセルは char が常に空白", () => {
    const b = new ScreenBuffer();
    b.setAttr(0, 0x27); // nonDisplay
    writeText(b, 1, 2, "SECRET");
    const row = b.snapshot("s", false).cells[0];
    expect(row?.[1]).toMatchObject({ char: " ", nonDisplay: true });
    expect(row?.[6]).toMatchObject({ char: " ", nonDisplay: true });
  });

  it("cells は常に全行 80 桁を保持する", () => {
    const s = new ScreenBuffer().snapshot("s", false);
    expect(s.cells).toHaveLength(24);
    for (const row of s.cells) expect(row).toHaveLength(80);
  });
});

describe("ScreenBuffer フィールド", () => {
  function makeField(b: ScreenBuffer, row: number, col: number, len: number, ffw: number, attr = 0x24) {
    const start = b.addrOf(row, col);
    b.setAttr(start - 1, attr);
    b.addField(start, len, ffw, attr);
  }

  it("setFieldValue が値を書き MDT を立てる", () => {
    const b = new ScreenBuffer();
    makeField(b, 6, 32, 10, INPUT_FFW);
    const f = b.fieldByIndex(1);
    b.setFieldValue(f, "TARO");
    expect(b.fieldValue(f)).toBe("TARO");
    expect(b.mdtFields()).toHaveLength(1);
    const snap = b.snapshot("s", false);
    expect(snap.fields[0]).toMatchObject({ index: 1, row: 6, col: 32, value: "TARO", mdt: true });
  });

  it("短い値で上書きすると残りはブランクになる", () => {
    const b = new ScreenBuffer();
    makeField(b, 1, 2, 5, INPUT_FFW);
    const f = b.fieldByIndex(1);
    b.setFieldValue(f, "ABCDE");
    b.setFieldValue(f, "Z");
    expect(b.fieldValue(f)).toBe("Z");
  });

  it("protected フィールドへの入力は FIELD_PROTECTED", () => {
    const b = new ScreenBuffer();
    makeField(b, 1, 2, 5, BYPASS_FFW);
    expect(() => b.setFieldValue(b.fieldByIndex(1), "X")).toThrow(
      expect.objectContaining({ code: "FIELD_PROTECTED" })
    );
  });

  it("長さ超過は FIELD_OVERFLOW", () => {
    const b = new ScreenBuffer();
    makeField(b, 1, 2, 3, INPUT_FFW);
    expect(() => b.setFieldValue(b.fieldByIndex(1), "ABCD")).toThrow(
      expect.objectContaining({ code: "FIELD_OVERFLOW" })
    );
  });

  it("hidden フィールド（nonDisplay 属性）は snapshot で value が空", () => {
    const b = new ScreenBuffer();
    makeField(b, 7, 32, 10, INPUT_FFW, 0x27); // nonDisplay attr
    b.setFieldValue(b.fieldByIndex(1), "PASSWORD");
    const snap = b.snapshot("s", false);
    expect(snap.fields[0]).toMatchObject({ hidden: true, value: "" });
    // グリッド上もマスクされている
    expect(snap.cells[6]?.[31]?.char).toBe(" ");
  });

  it("numeric 判定（数字専用シフト）", () => {
    const b = new ScreenBuffer();
    makeField(b, 1, 2, 5, FFW.ID_VALUE | FFW.SHIFT_NUMERIC_ONLY);
    expect(b.snapshot("s", false).fields[0]?.numeric).toBe(true);
  });

  it("同一開始アドレスの SF 再定義は置換される", () => {
    const b = new ScreenBuffer();
    makeField(b, 1, 2, 5, INPUT_FFW);
    makeField(b, 1, 2, 8, INPUT_FFW);
    expect(b.orderedFields()).toHaveLength(1);
    expect(b.orderedFields()[0]?.length).toBe(8);
  });

  it("DBCS FCW（0x8200/0x8240/0x8280）を dbcsType に解釈する", () => {
    const b = new ScreenBuffer();
    b.setAttr(b.addrOf(1, 1), 0x24);
    b.addField(b.addrOf(1, 2), 20, FFW.ID_VALUE, 0x24, "pure");
    expect(b.snapshot("t", false).fields[0]?.dbcsType).toBe("pure");
  });

  it("clearUnit で全部リセットされる", () => {
    const b = new ScreenBuffer();
    makeField(b, 1, 2, 5, INPUT_FFW);
    b.setFieldValue(b.fieldByIndex(1), "AB");
    b.cursorAddr = 100;
    b.clearUnit();
    expect(b.orderedFields()).toHaveLength(0);
    expect(b.cursorAddr).toBe(0);
    expect(b.snapshot("s", false).cells[0]?.[1]?.char).toBe(" ");
  });
});
