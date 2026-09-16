import { describe, it, expect } from "vitest";
import { ScreenBuffer } from "../src/screen/buffer.js";
import { applyDataStream } from "../src/protocol/wtd-applier.js";
import {
  buildReadScreenResponse,
  buildReadScreenExtendedResponse
} from "../src/protocol/save-screen.js";
import { codecForCcsid } from "@ts5250/ebcdic/codec";
import { ESC, COMMAND, ORDER } from "../src/protocol/constants.js";

const codec = codecForCcsid(37);

function screenWith(stream: number[]): ScreenBuffer {
  const buf = new ScreenBuffer();
  applyDataStream(Uint8Array.from(stream), buf, codec, () => {});
  return buf;
}

/** READ SCREEN EXTENDED 応答を行ごとに切り出す（GDS ヘッダ 10 バイトを外し 0xFF 区切り） */
function rows(record: Uint8Array): Uint8Array[] {
  const body = record.slice(10);
  const out: Uint8Array[] = [];
  let start = 0;
  for (let i = 0; i < body.length; i++) {
    if (body[i] === 0xff) {
      out.push(body.slice(start, i));
      start = i + 1;
    }
  }
  return out;
}

/**
 * `read-screen-field-end.test.ts` の続き: SOH 相当（CLEAR FORMAT TABLE）でフィールドテーブルが
 * 消えた**後**に READ SCREEN 系の応答を組んだ場合の回帰。
 *
 * 窓を重ねる過程でホストが CLEAR FORMAT TABLE を送ってフィールドを消し（実機の Attn で
 * フィールドが 44→2 になる挙動と同種）、その直後に READ SCREEN／READ SCREEN EXTENDED で
 * 「今の画面」を尋ねてくることがある（ASSUME 付き WINDOW、SEU の F4 窓の上に F1 ヘルプ窓を
 * 開く操作で発生）。`fieldEndAttrAddrs` が生きている `fields` だけを見ていると、消えた
 * フィールドの終端に閉じ属性を送れない——ホストはこの応答をそのまま「現在の背面」として
 * 描き直す（CLEAR UNIT ＋全画面 WTD）ため、下線が入力範囲を越えて伸びたまま**ホスト側の
 * データとして焼き込まれてしまう**（利用者報告の再現）。
 */
describe("画面イメージ応答のフィールド閉じ属性（フォーマットテーブルが消えた後）", () => {
  /** 下線フィールド（(3,21) 属性 0x24・長さ 10）に 9 桁だけ書き、その後 CLEAR FORMAT TABLE */
  function pdmLikeScreenThenClearFormatTable(): ScreenBuffer {
    return screenWith([
      ESC, COMMAND.WRITE_TO_DISPLAY, 0x00, 0x00,
      ORDER.SBA, 3, 21,
      ORDER.SF, 0x40, 0x00, 0x24, 0x00, 0x0a,
      ...codec.encode("QRPGLESRC").bytes,
      ESC, COMMAND.CLEAR_FORMAT_TABLE
    ]);
  }

  it("フィールドテーブルが消えていても、消える前の終端に閉じ属性を置く（READ SCREEN EXTENDED）", () => {
    const buf = pdmLikeScreenThenClearFormatTable();
    expect(buf.orderedFields()).toHaveLength(0); // 前提: フィールドは本当に消えている
    const row3 = rows(buildReadScreenExtendedResponse(buf, codec))[2]!;
    // col 21 = 開始属性 0x24（文字桁ではないのでフィールド消滅後も残る）、col 31 = 閉じ属性
    expect(row3[20]).toBe(0x24);
    expect(row3[31]).toBe(0x20);
  });

  it("フィールドテーブルが消えていても、消える前の終端に閉じ属性を置く（READ SCREEN）", () => {
    const buf = pdmLikeScreenThenClearFormatTable();
    const body = buildReadScreenResponse(buf, codec).slice(10);
    const row3 = body.slice(2 + 2 * 80, 2 + 3 * 80); // カーソル行桁 2 バイトの後、3 行目
    expect(row3[20]).toBe(0x24);
    expect(row3[31]).toBe(0x20);
  });

  it("消えた終端でもホストが書いた桁は閉じ属性で潰さない", () => {
    const buf = screenWith([
      ESC, COMMAND.WRITE_TO_DISPLAY, 0x00, 0x00,
      ORDER.SBA, 3, 21,
      ORDER.SF, 0x40, 0x00, 0x24, 0x00, 0x0a,
      ...codec.encode("QRPGLESRC").bytes,
      0x00, // (3,31)
      ...codec.encode("X").bytes, // (3,32) ホストが書いた桁
      ESC, COMMAND.CLEAR_FORMAT_TABLE
    ]);
    const row3 = rows(buildReadScreenExtendedResponse(buf, codec))[2]!;
    expect(row3[31]).toBe(codec.encode("X").bytes[0]);
  });

  it("その行をホストが書き直していれば、消えた終端の引き継ぎは無効（行の中身がもう別物）", () => {
    const buf = screenWith([
      ESC, COMMAND.WRITE_TO_DISPLAY, 0x00, 0x00,
      ORDER.SBA, 3, 21,
      ORDER.SF, 0x40, 0x00, 0x24, 0x00, 0x0a,
      ...codec.encode("QRPGLESRC").bytes,
      ESC, COMMAND.CLEAR_FORMAT_TABLE,
      ESC, COMMAND.WRITE_TO_DISPLAY, 0x00, 0x00,
      ORDER.SBA, 3, 21,
      ...codec.encode("REWRITTEN").bytes // 同じ行を書き直す（閉じ属性の引き継ぎは捨てられる）
    ]);
    const row3 = rows(buildReadScreenExtendedResponse(buf, codec))[2]!;
    expect(row3[31]).not.toBe(0x20); // 書き直された行に古い閉じ属性を持ち込まない
  });
});
