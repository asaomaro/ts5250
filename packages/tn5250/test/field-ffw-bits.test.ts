import { describe, it, expect } from "vitest";
import { applyDataStream } from "../src/protocol/wtd-applier.js";
import { ScreenBuffer } from "../src/screen/buffer.js";
import { codecForCcsid } from "@as400web/ebcdic/codec";
import { validateFieldContent } from "../src/screen/field-validate.js";
import { ESC, COMMAND, ORDER, FFW } from "../src/protocol/constants.js";
import type { InternalField } from "../src/screen/buffer.js";

const codec = codecForCcsid(37);

/**
 * **FFW の挙動ビットが `Field` の任意フラグへ正しく写るか。**
 *
 * 期待値は**実機の実測値をそのまま置いている**（実機 / IBM i 7.3・2026-07-29。
 * `scripts/build-ffwtest.mjs` で DDS を作り `scripts/research-ffw.mjs` が
 * 生データストリームから採取。詳細は `.aidev/works/20260729-ffw-behavior-bits/research.md` 2.2）。
 *
 * | DDS | FFW | 意味 |
 * |---|---|---|
 * | `6A  I`            | `0x4020` | 素の英数字欄。**MONOCASE は既定で立つ** |
 * | `6A  I CHECK(LC)`  | `0x4000` | `CHECK(LC)` を書いた欄だけ MONOCASE が落ちる |
 * | `6X  I`            | `0x4120` | 英字専用 ＋ MONOCASE |
 * | `6N  I`            | `0x4220` | 数字シフト ＋ MONOCASE（制限ではない） |
 * | `6W  I`            | `0x4400` | カタカナ。MONOCASE は立たない |
 * | `6D  I`            | `0x4500` | 数字のみ |
 * | `6I  I`            | `0x4600` | **キーボード入力不可** |
 * | `6M  I`            | `0x4300` | 数値のみ（文字欄） |
 * | `6A  I CHECK(ER)`  | `0x40a0` | **AUTO_ENTER** ＋ MONOCASE |
 * | `6A  B CHECK(FE)`  | `0x4060` | FER ＋ MONOCASE（前作 #205 の実測） |
 * | `6A  B CHECK(ME)`  | `0x4028` | MANDATORY_ENTER ＋ MONOCASE（同上） |
 */
describe("FFW の挙動ビット → Field の任意フラグ（実測値で固定）", () => {
  /** 行 5 桁 10 に FFW 指定つきの入力欄を 1 つ置く WTD */
  function fieldWithFfw(ffw: number): Uint8Array {
    return Uint8Array.from([
      ESC, COMMAND.WRITE_TO_DISPLAY, 0x00, 0x00,
      ORDER.SBA, 5, 10,
      ORDER.SF, (ffw >> 8) & 0xff, ffw & 0xff, 0x20, 0x00, 8
    ]);
  }
  const fieldOf = (ffw: number) => {
    const buf = new ScreenBuffer();
    applyDataStream(fieldWithFfw(ffw), buf, codec);
    return buf.snapshot("s", false).fields[0]!;
  };

  it("0x4020（素の英数字欄）: MONOCASE だけが立つ", () => {
    const f = fieldOf(0x4020);
    expect(f.monocase).toBe(true);
    expect(f.alphaOnly).toBeUndefined();
    expect(f.keyboardInhibited).toBeUndefined();
    expect(f.autoEnter).toBeUndefined();
    expect(f.fieldExitRequired).toBeUndefined();
    expect(f.mandatoryEnter).toBeUndefined();
  });

  it("0x4000（CHECK(LC)）: **MONOCASE が立たない**", () => {
    // これが立ってしまうと「全欄が大文字になる」実装と区別できない
    expect(fieldOf(0x4000).monocase).toBeUndefined();
  });

  it("0x4120（DDS の X）: alphaOnly ＋ MONOCASE", () => {
    const f = fieldOf(0x4120);
    expect(f.alphaOnly).toBe(true);
    expect(f.monocase).toBe(true);
    expect(f.numeric).toBe(false);
  });

  it("0x4220（DDS の N・数字シフト）: **制限フラグは何も立たない**", () => {
    const f = fieldOf(0x4220);
    expect(f.alphaOnly).toBeUndefined();
    expect(f.keyboardInhibited).toBeUndefined();
    expect(f.numeric).toBe(false); // シフト状態であって数値欄ではない
    expect(f.monocase).toBe(true);
  });

  it("0x4400（DDS の W・カタカナ）: **入力制限ではない**ので何も立たない", () => {
    // 参照実装 2 つとも素通し（GNU tn5250 は "KATAKANA not implemented"）。
    // 制限だと誤解して実装されないよう固定する
    const f = fieldOf(0x4400);
    expect(f.alphaOnly).toBeUndefined();
    expect(f.keyboardInhibited).toBeUndefined();
    expect(f.numeric).toBe(false);
    expect(f.monocase).toBeUndefined();
  });

  it("0x4500（DDS の D）: digitsOnly。**0x0600 ではない**", () => {
    expect(fieldOf(0x4500).digitsOnly).toBe(true);
    expect(fieldOf(0x4500).keyboardInhibited).toBeUndefined();
  });

  it("0x4600（DDS の I）: keyboardInhibited。digitsOnly ではない", () => {
    const f = fieldOf(0x4600);
    expect(f.keyboardInhibited).toBe(true);
    expect(f.digitsOnly).toBeUndefined();
  });

  it("0x4300（DDS の M）: 数値欄扱い", () => {
    const f = fieldOf(0x4300);
    expect(f.numeric).toBe(true);
    expect(f.digitsOnly).toBeUndefined();
  });

  it("0x40a0（CHECK(ER)）: autoEnter ＋ MONOCASE", () => {
    const f = fieldOf(0x40a0);
    expect(f.autoEnter).toBe(true);
    expect(f.monocase).toBe(true);
    expect(f.fieldExitRequired).toBeUndefined();
  });

  it("0x4060（CHECK(FE)）: fieldExitRequired", () => {
    const f = fieldOf(0x4060);
    expect(f.fieldExitRequired).toBe(true);
    expect(f.autoEnter).toBeUndefined();
  });

  it("0x4028（CHECK(ME)）: mandatoryEnter", () => {
    const f = fieldOf(0x4028);
    expect(f.mandatoryEnter).toBe(true);
  });

  it("0x4027（CHECK(MF)）: adjust=mandatory-fill（専用フラグは足していない）", () => {
    // 同じ事実の導出元を 2 つ作らない。web-ui は adjust を見る
    const f = fieldOf(0x4027);
    expect(f.adjust).toBe("mandatory-fill");
  });
});

describe("validateFieldContent: 英字専用（alpha-only）", () => {
  const fieldWith = (ffw: number): InternalField =>
    ({ ffw, length: 6, startAddr: 0, attrByte: 0x20, mdt: false }) as unknown as InternalField;

  const alphaOnly = fieldWith(0x4000 | FFW.SHIFT_ALPHA_ONLY);

  it("英字・カンマ・ピリオド・ハイフン・空白は通る", () => {
    for (const v of ["ABC", "abc", "A,B", "A.B", "A-B", "A B", ""]) {
      expect(() => validateFieldContent(v, alphaOnly, codec), v).not.toThrow();
    }
  });

  it("数字は弾く（これが alpha-only の要）", () => {
    expect(() => validateFieldContent("A1", alphaOnly, codec)).toThrow(/alphabetic-only/);
  });

  it("記号も弾く", () => {
    expect(() => validateFieldContent("A#", alphaOnly, codec)).toThrow(/alphabetic-only/);
  });

  it("**キーボード入力不可（0x0600）は core では弾かない**", () => {
    // 「キーボードから入力できない」という制約であって値の制約ではないので、
    // 送信時検証（ペースト・マクロ・MCP も通る経路）で塞ぐと入力手段ごと失われる
    const io = fieldWith(0x4000 | FFW.SHIFT_IO);
    expect(() => validateFieldContent("ABC123", io, codec)).not.toThrow();
  });

  it("カタカナシフト（0x0400）も弾かない", () => {
    const kata = fieldWith(0x4000 | FFW.SHIFT_KATAKANA);
    expect(() => validateFieldContent("ABC123", kata, codec)).not.toThrow();
  });
});
