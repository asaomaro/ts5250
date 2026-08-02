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

/**
 * **画面イメージ応答にフィールドの閉じ属性を入れる。**
 *
 * 5250 のフィールドは開始属性しか持たず、終端はフォーマットテーブルの長さで決まる。
 * READ SCREEN 系の応答にはフォーマットテーブルが乗らないので、そのまま送ると
 * 「下線がどこで終わるか」がホストに伝わらない。ホストはヘルプウィンドウを出すとき
 * この応答を CLEAR UNIT ＋全画面 WTD で描き直して背面を再現するため、閉じ属性が無いと
 * **背面の下線が入力範囲を越えて行末まで伸び、次行へ回り込む**（ACS は背面がヘルプ前と
 * まったく変わらない。実機の PDM F1 ヘルプで確認）。
 */
function screenWith(stream: number[]): ScreenBuffer {
  const buf = new ScreenBuffer();
  applyDataStream(Uint8Array.from(stream), buf, codec, () => {});
  return buf;
}

/** 下線フィールド（(3,21) 属性 0x24・長さ 10）に 9 桁だけ書いた画面。終端は (3,32) */
function pdmLikeScreen(): ScreenBuffer {
  return screenWith([
    ESC, COMMAND.WRITE_TO_DISPLAY, 0x00, 0x00,
    ORDER.SBA, 3, 21,
    ORDER.SF, 0x40, 0x00, 0x24, 0x00, 0x0a,
    ...codec.encode("QRPGLESRC").bytes
  ]);
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

describe("画面イメージ応答のフィールド閉じ属性", () => {
  it("READ SCREEN EXTENDED はフィールド終端に通常属性 0x20 を置く", () => {
    const row3 = rows(buildReadScreenExtendedResponse(pdmLikeScreen(), codec))[2]!;
    // col 21 = 開始属性 0x24、col 22-30 = QRPGLESRC、col 31 = 未書き込み(NUL)、col 32 = 閉じ属性
    expect(row3[20]).toBe(0x24);
    expect(row3[30]).toBe(0x00);
    expect(row3[31]).toBe(0x20);
    // 閉じ属性で行末の切り詰めが止まる（＝ホストの描き直しに必ず含まれる）
    expect(row3.length).toBe(32);
  });

  it("READ SCREEN（0x62）でも同じ位置に閉じ属性が入る", () => {
    const body = buildReadScreenResponse(pdmLikeScreen(), codec).slice(10);
    const row3 = body.slice(2 + 2 * 80, 2 + 3 * 80); // カーソル行桁 2 バイトの後、3 行目
    expect(row3[20]).toBe(0x24);
    expect(row3[31]).toBe(0x20);
  });

  it("ホストが書いた桁は閉じ属性で潰さない", () => {
    // 終端 (3,32) にホストが 'X' を書いている画面
    const buf = screenWith([
      ESC, COMMAND.WRITE_TO_DISPLAY, 0x00, 0x00,
      ORDER.SBA, 3, 21,
      ORDER.SF, 0x40, 0x00, 0x24, 0x00, 0x0a,
      ...codec.encode("QRPGLESRC").bytes,
      0x00, // (3,31)
      ...codec.encode("X").bytes // (3,32)
    ]);
    const row3 = rows(buildReadScreenExtendedResponse(buf, codec))[2]!;
    expect(row3[31]).toBe(codec.encode("X").bytes[0]);
  });

  it("別の欄のデータ桁に食い込む場合は入れない（欄が隙間なく並ぶ画面）", () => {
    // (5,1) 属性 + 長さ 3 の欄（cols 2-4）／終端 (5,5) は次の欄の属性桁
    const buf = screenWith([
      ESC, COMMAND.WRITE_TO_DISPLAY, 0x00, 0x00,
      ORDER.SBA, 5, 1,
      ORDER.SF, 0x40, 0x00, 0x24, 0x00, 0x03,
      0x00, 0x00, 0x00,
      ORDER.SBA, 5, 5,
      ORDER.SF, 0x40, 0x00, 0x28, 0x00, 0x03
    ]);
    const row5 = rows(buildReadScreenExtendedResponse(buf, codec))[4]!;
    expect(row5[4]).toBe(0x28); // 次の欄の開始属性がそのまま残る
  });
});
