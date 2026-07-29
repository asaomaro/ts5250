import { describe, it, expect } from "vitest";
import { applyDataStream } from "../src/protocol/wtd-applier.js";
import { buildReadMdtResponse } from "../src/protocol/read-response.js";
import { ScreenBuffer } from "../src/screen/buffer.js";
import { codecForCcsid } from "../src/codec/codec.js";
import { validateFieldContent } from "../src/screen/field-validate.js";
import { rawSentinel } from "../src/screen/attr-sentinel.js";
import { ESC, COMMAND, ORDER, FFW } from "../src/protocol/constants.js";
import type { InternalField } from "../src/screen/buffer.js";

const codec = codecForCcsid(37);

/**
 * **符号付き数値欄の送信表現。**
 *
 * 5250 の符号付き数値欄はワイヤ上 `桁数 + 1` バイトで、**最終桁が符号桁**（空白 = 正 / `-` = 負）。
 * 送信時は **符号桁を送らず、負なら最終桁のゾーンを 0xD にする**
 * （GNU tn5250 `session.c:551-566`）。
 *
 * 【実機で裏づけ】実機 / IBM i 7.5・2026-07-30（`scripts/research-sign.mjs`）
 *
 * | 送った形 | ホストが受け取った値 |
 * |---|---|
 * | `-12`（**変更前の実装**） | `12` … **符号が黙って落ちる** |
 * | `    12-`（7 バイトそのまま） | **CPF5257 入出力エラー**（桁あふれ） |
 * | `    12`（6 バイト） | `12` |
 *
 * 変更前は負値がまったく送れず、しかもエラーにもならなかった（利用者は気づけない）。
 */
describe("符号付き数値欄の送信変換", () => {
  /** 行 5 桁 10 に shift 指定つきの入力欄を 1 つ置き、値を入れて Read MDT 応答を作る */
  function respond(shift: number, value: string, length = 7): number[] {
    const ffw = 0x4000 | shift;
    const buf = new ScreenBuffer();
    applyDataStream(
      Uint8Array.from([
        ESC, COMMAND.WRITE_TO_DISPLAY, 0x00, 0x00,
        ORDER.SBA, 5, 10,
        ORDER.SF, (ffw >> 8) & 0xff, ffw & 0xff, 0x20, 0x00, length
      ]),
      buf,
      codec
    );
    const f = buf.orderedFields()[0]!;
    buf.setFieldValue(f, value);
    const { record } = buildReadMdtResponse(buf, codec, 0xf1);
    // レコード = GDS ヘッダ + カーソル行 + 桁 + AID + `SBA 行 桁` + フィールドデータ。
    // ヘッダ長を数え間違えないよう、**最初の SBA を探して**その 3 バイト後ろから取る
    const bytes = [...record];
    const sba = bytes.indexOf(ORDER.SBA);
    return bytes.slice(sba + 3);
  }

  it("負値: 符号桁を送らず、最終桁のゾーンが 0xD になる", () => {
    // "    12-" → 40 40 40 40 F1 D2（= −12）。**7 バイト目は送らない**
    expect(respond(FFW.SHIFT_SIGNED_NUMERIC, "    12-")).toEqual([0x40, 0x40, 0x40, 0x40, 0xf1, 0xd2]);
  });

  it("正値: 符号桁（空白）を落とすだけでゾーンは変えない", () => {
    expect(respond(FFW.SHIFT_SIGNED_NUMERIC, "    12 ")).toEqual([0x40, 0x40, 0x40, 0x40, 0xf1, 0xf2]);
  });

  it("符号桁だけの欄（値なし）は何も送らない", () => {
    expect(respond(FFW.SHIFT_SIGNED_NUMERIC, "      -")).toEqual([]);
  });

  it("符号桁の手前が数字でなければゾーンを変えない（符号桁は落とす）", () => {
    // "     A-" → 手前が英字なのでゾーン加工はしない
    expect(respond(FFW.SHIFT_SIGNED_NUMERIC, "     A-")).toEqual([0x40, 0x40, 0x40, 0x40, 0x40, 0xc1]);
  });

  it("**符号付きでない数値欄は 1 バイトも変わらない**（回帰）", () => {
    // numeric-only。符号桁という概念が無いので末尾空白を落とすだけ
    expect(respond(FFW.SHIFT_NUMERIC_ONLY, "    12 ")).toEqual([0x40, 0x40, 0x40, 0x40, 0xf1, 0xf2]);
    // 末尾が `-` でも触らない（そのまま送る）
    expect(respond(FFW.SHIFT_NUMERIC_ONLY, "    12-")).toEqual([0x40, 0x40, 0x40, 0x40, 0xf1, 0xf2, 0x60]);
  });

  it("英数字欄も変わらない（回帰）", () => {
    expect(respond(0x0000, "AB-")).toEqual([0xc1, 0xc2, 0x60]);
  });
});

describe("Dup 文字（0x1C）と型検証", () => {
  const fieldWith = (ffw: number): InternalField =>
    ({ ffw, length: 6, startAddr: 0, attrByte: 0x20, mdt: false }) as unknown as InternalField;

  it("**数値欄でもセンチネル（生バイト）は型検証を通る**", () => {
    // Dup はカーソル以降を 0x1C で埋める。センチネルを「打った文字」として数えると
    // 「数字しか入らない」で自分の入力を弾いてしまい、数値欄で Dup が使えなくなる
    const dup = rawSentinel(0x1c).repeat(6);
    for (const shift of [FFW.SHIFT_NUMERIC_ONLY, FFW.SHIFT_DIGITS_ONLY, FFW.SHIFT_SIGNED_NUMERIC]) {
      expect(() => validateFieldContent(dup, fieldWith(0x4000 | shift), codec), `shift=${shift}`).not.toThrow();
    }
  });

  it("英字専用欄でもセンチネルは通る", () => {
    const dup = rawSentinel(0x1c).repeat(3);
    expect(() => validateFieldContent(dup, fieldWith(0x4000 | FFW.SHIFT_ALPHA_ONLY), codec)).not.toThrow();
  });

  it("センチネルを外しても**本来の型違反は弾く**（空振りしていない）", () => {
    const bad = rawSentinel(0x1c) + "A";
    expect(() => validateFieldContent(bad, fieldWith(0x4000 | FFW.SHIFT_DIGITS_ONLY), codec)).toThrow(/digits only/);
  });
});

describe("Field.dupEnable", () => {
  function fieldOf(ffw: number) {
    const buf = new ScreenBuffer();
    applyDataStream(
      Uint8Array.from([
        ESC, COMMAND.WRITE_TO_DISPLAY, 0x00, 0x00,
        ORDER.SBA, 5, 10,
        ORDER.SF, (ffw >> 8) & 0xff, ffw & 0xff, 0x20, 0x00, 6
      ]),
      buf,
      codec
    );
    return buf.snapshot("s", false).fields[0]!;
  }

  it("0x5020（DDS の `DUP` キーワード）で dupEnable が立つ", () => {
    // 実機実測: `6A B DUP` → FFW=0x5020（DUP_ENABLE 0x1000 ＋ MONOCASE 0x0020）
    const f = fieldOf(0x5020);
    expect(f.dupEnable).toBe(true);
    expect(f.monocase).toBe(true);
  });

  it("指定の無い欄では立たない", () => {
    expect(fieldOf(0x4020).dupEnable).toBeUndefined();
  });
});
