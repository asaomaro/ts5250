import { describe, it, expect } from "vitest";
import { Screen3270 } from "../src/screen/buffer.js";
import { parseFieldAttr } from "../src/screen/attributes.js";
import { ATTR, DISPLAY } from "../src/protocol/constants.js";

describe("Screen3270 のサイズ（spec D5: 標準 24x80 と代替）", () => {
  it("初期状態は標準サイズ", () => {
    const s = new Screen3270(5);
    expect([s.rows, s.cols]).toEqual([24, 80]);
    expect(s.alternate).toBe(false);
  });

  it("EW は標準・EWA は代替（モデル 5 = 27x132）", () => {
    const s = new Screen3270(5);
    s.resize(true);
    expect([s.rows, s.cols]).toEqual([27, 132]);
    expect(s.alternate).toBe(true);
    s.resize(false);
    expect([s.rows, s.cols]).toEqual([24, 80]);
    expect(s.alternate).toBe(false);
  });

  it("モデル 2 は代替も 24x80（RFC 1576）", () => {
    const s = new Screen3270(2);
    s.resize(true);
    expect([s.rows, s.cols]).toEqual([24, 80]);
  });
});

describe("属性桁はバッファの 1 桁を占める", () => {
  it("startField した桁は属性桁になり文字を持たない", () => {
    const s = new Screen3270(2);
    s.startField(0, 0xe0);
    expect(s.isAttrPos(0)).toBe(true);
    expect(s.charAt(0)).toBe(0x00);
    expect(s.attrAt(0)).toBe(0xe0);
  });

  it("データを書くと属性桁は消える（上書きされたのだから）", () => {
    const s = new Screen3270(2);
    s.startField(5, 0xe0);
    s.writeChar(5, 0xc1);
    expect(s.isAttrPos(5)).toBe(false);
    expect(s.charAt(5)).toBe(0xc1);
  });
});

describe("フィールドの帰属（手前の属性桁が支配する）", () => {
  it("属性桁の次から次の属性桁の直前までが 1 つの欄", () => {
    const s = new Screen3270(2);
    s.startField(0, 0x20); // 保護
    s.startField(10, 0x00); // 非保護
    expect(s.fieldAttrPosFor(5)).toBe(0);
    expect(s.isProtectedAt(5)).toBe(true);
    expect(s.fieldAttrPosFor(11)).toBe(10);
    expect(s.isProtectedAt(11)).toBe(false);
  });

  it("**環状に**手前を探す（先頭より前は末尾へ回る）", () => {
    const s = new Screen3270(2);
    s.startField(1900, 0x20);
    // 桁 5 の手前に属性桁は無いので、環状に 1900 が支配する
    expect(s.fieldAttrPosFor(5)).toBe(1900);
    expect(s.isProtectedAt(5)).toBe(true);
  });

  it("属性桁が無ければ非フォーマット画面で、全体が非保護", () => {
    const s = new Screen3270(2);
    expect(s.unformatted).toBe(true);
    expect(s.fieldAttrPosFor(100)).toBe(-1);
    expect(s.isProtectedAt(100)).toBe(false);
  });
});

describe("MDT は属性桁のビットに持つ（真実は 1 箇所）", () => {
  it("欄に MDT を立てると属性バイトのビットが立つ", () => {
    const s = new Screen3270(2);
    s.startField(0, 0x00);
    s.setMdtFor(5, true);
    expect(parseFieldAttr(s.attrAt(0)).modified).toBe(true);
    expect(s.attrAt(0) & ATTR.MDT).toBe(ATTR.MDT);
  });

  it("resetAllMdt で全欄が落ちる", () => {
    const s = new Screen3270(2);
    s.startField(0, ATTR.MDT);
    s.startField(50, ATTR.MDT | ATTR.PROTECTED);
    s.resetAllMdt();
    expect(parseFieldAttr(s.attrAt(0)).modified).toBe(false);
    expect(parseFieldAttr(s.attrAt(50)).modified).toBe(false);
  });
});

describe("非保護欄の消去（EAU / EUA の土台）", () => {
  it("非保護欄だけ消え、保護欄は残る", () => {
    const s = new Screen3270(2);
    s.startField(0, 0x20); // 保護
    s.writeChar(1, 0xc1);
    s.startField(10, 0x00); // 非保護
    s.writeChar(11, 0xc2);
    s.eraseUnprotected();
    expect(s.charAt(1)).toBe(0xc1); // 保護欄は残る
    expect(s.charAt(11)).toBe(0x00); // 非保護欄は消える
  });
});

describe("次の非保護欄へ（PT オーダー）", () => {
  it("非保護の属性桁の次の桁を返す", () => {
    const s = new Screen3270(2);
    s.startField(0, 0x20); // 保護
    s.startField(10, 0x00); // 非保護
    expect(s.nextUnprotected(0)).toBe(11);
  });
});

describe("自動スキップ（保護＋数字）", () => {
  it("実測どおり保護と数字が同時に立つと autoSkip", () => {
    // attr.trc: 0xF0 → protected,skip
    const a = parseFieldAttr(0xf0);
    expect(a.protected).toBe(true);
    expect(a.numeric).toBe(true);
    expect(a.autoSkip).toBe(true);
  });

  it("保護だけなら autoSkip ではない", () => {
    expect(parseFieldAttr(0xe0).autoSkip).toBe(false);
  });

  it("表示ビットの意味（実測: 0x08=intensified / 0x0C=nondisplay / 0x04=detectable）", () => {
    expect(parseFieldAttr(DISPLAY.INTENSIFIED).intensified).toBe(true);
    expect(parseFieldAttr(DISPLAY.NONDISPLAY).hidden).toBe(true);
    expect(parseFieldAttr(DISPLAY.DETECTABLE).detectable).toBe(true);
  });

  it("0x02 / 0x40 / 0x80 は意味を持たない（実測: default）", () => {
    // 埋めビットなので 0xE0 と 0x20 は同じ「保護」
    expect(parseFieldAttr(0xe0)).toEqual(parseFieldAttr(0x20));
    expect(parseFieldAttr(0x02)).toEqual(parseFieldAttr(0x00));
  });
});
