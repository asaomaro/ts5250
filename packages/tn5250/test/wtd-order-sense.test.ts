import { describe, it, expect } from "vitest";
import { applyDataStream } from "../src/protocol/wtd-applier.js";
import { ScreenBuffer } from "../src/screen/buffer.js";
import { codecForCcsid } from "@ts5250/ebcdic/codec";
import { ESC, COMMAND, ORDER } from "../src/protocol/constants.js";

/**
 * **WTD の中のオーダーの誤りは否定応答にして打ち切る。CC2 は落とさない**（`20260927-wtd-order-sense`。ACS `DS5250.processWriteToDisplay`）。
 * 実機（社内機）で DSM に WTD（CC2＝メッセージ待ち・5 行に WTDERR）＋誤ったオーダーの 1 レコードを 5 通り出させ、ACS のコアは誤りの前の文字を書き・
 * メッセージ待ちを点け・否定応答を返した（ホストの次の出力が CPFA303。`scripts/acs-probe/wtd-order-sense.txt`・`scripts/verify-wtd-order-sense.mjs`）。
 * 以前は読み過ぎ・範囲外の例外でレコードの結果ごと捨て、応答もしなかった
 */
const codec = codecForCcsid(37);
/** WTD（CC2＝警報＋メッセージ待ち）で 5 行 2 桁に "AB"。この後ろに誤ったオーダーを置く（今の位置は 5 行 4 桁） */
const HEAD = [ESC, COMMAND.WRITE_TO_DISPLAY, 0x00, 0x05, ORDER.SBA, 5, 2, 0xc1, 0xc2];
/** 誤りの後ろの READ（読まれないこと＝打ち切りを見る） */
const READ = [ESC, COMMAND.READ_MDT_FIELDS, 0x00, 0x00];
function run(order: number[], tail = READ) {
  const buf = new ScreenBuffer();
  const r = applyDataStream(Uint8Array.from([...HEAD, ...order, ...tail]), buf, codec, () => {});
  return { r, row5: buf.snapshot().cells[4]!.map((c) => c.char).join("").trim(), buf };
}

describe("WTD の中のオーダーの誤り", () => {
  const cases: [string, number[], number][] = [
    ["SBA の行が画面の外", [ORDER.SBA, 30, 2], 0x10050122],
    ["SBA の桁が画面の外", [ORDER.SBA, 5, 81], 0x10050122],
    ["SBA の行 0", [ORDER.SBA, 0, 5], 0x10050122],
    ["SBA の行 25（境界）", [ORDER.SBA, 25, 5], 0x10050122],
    ["SBA の桁 0（行 1 以外）", [ORDER.SBA, 5, 0], 0x10050122],
    ["IC が画面の外", [ORDER.IC, 30, 2], 0x10050122],
    ["MC が画面の外", [ORDER.MC, 5, 0], 0x10050122],
    ["RA が画面の外", [ORDER.RA, 30, 2, 0x5c], 0x10050122],
    ["RA の後戻り", [ORDER.RA, 5, 2, 0x5c], 0x10050123],
    ["RA の 1 桁の後戻り（境界）", [ORDER.RA, 5, 3, 0x5c], 0x10050123],
    ["EA の 1 桁の後戻り（境界）", [ORDER.EA, 5, 3, 0x02, 0x00], 0x10050123],
    ["EA が画面の外", [ORDER.EA, 30, 2, 0x02, 0x00], 0x10050122],
    ["EA の長さ 7", [ORDER.EA, 6, 2, 0x07, 0, 0, 0, 0, 0, 0], 0x1005012d],
    ["EA の長さ 1", [ORDER.EA, 6, 2, 0x01], 0x1005012d],
    ["EA の長さ 0", [ORDER.EA, 6, 2, 0x00], 0x1005012d],
    ["EA の長さ 6（境界）", [ORDER.EA, 6, 2, 0x06, 0, 0, 0, 0, 0], 0x1005012d],
    ["EA の後戻り", [ORDER.EA, 5, 2, 0x02, 0x00], 0x10050123],
    ["SOH の長さ 0", [ORDER.SOH, 0x00], 0x1005012b],
    ["SOH の長さ 8", [ORDER.SOH, 0x08, 0, 0, 0, 0, 0, 0, 0, 0], 0x1005012b]
  ];
  for (const [label, order, sense] of cases) {
    it(`${label}: 否定応答 0x${sense.toString(16)}・前の文字は書く・CC2 は効く・後ろは読まない`, () => {
      const { r, row5 } = run(order);
      expect(r.senseCode).toBe(sense);
      expect(row5).toBe("AB");
      expect(r.alarm).toBe(true);
      expect(r.messageWaiting).toBe(true);
      expect(r.readRequested).toBe(false);
    });
  }

  const shorts: [string, number[]][] = [
    ["SBA が 1 バイト", [ORDER.SBA, 5]],
    ["IC が 1 バイト", [ORDER.IC, 5]],
    ["MC が 1 バイト", [ORDER.MC, 5]],
    ["RA が 2 バイト", [ORDER.RA, 5, 9]],
    ["EA が 2 バイト", [ORDER.EA, 6, 2]],
    ["EA の属性タイプがレコードを越える", [ORDER.EA, 6, 2, 0x05, 0x00]],
    ["SOH の長さが無い（ACS はレコードの外を読む——当 PJ の決め）", [ORDER.SOH]],
    ["SOH の本体がレコードを越える", [ORDER.SOH, 0x07, 0x00]],
    ["TD の長さが 1 バイト", [ORDER.TD, 0x00]],
    ["TD の本体がレコードを越える", [ORDER.TD, 0x00, 0x05, 0xc1]],
    ["SF が 1 バイト", [ORDER.SF, 0x20]],
    ["WEA が 1 バイト", [ORDER.WEA, 0x01]]
  ];
  for (const [label, order] of shorts) {
    it(`${label}（レコードの終わり）: 否定応答 0x10050121・CC2 は効く`, () => {
      const { r, row5 } = run(order, []);
      expect(r.senseCode).toBe(0x10050121);
      expect(row5).toBe("AB");
      expect(r.alarm).toBe(true);
      expect(r.messageWaiting).toBe(true);
    });
  }

  it("ちょうどレコードの終わりに収まる EA・SOH・TD は否定応答にしない。1 バイト足りなければ 0x10050121", () => {
    for (const [ok, short] of [
      [[ORDER.EA, 6, 2, 0x03, 0x00, 0x01], [ORDER.EA, 6, 2, 0x03, 0x00]],
      [[ORDER.SOH, 0x03, 0, 0, 0], [ORDER.SOH, 0x03, 0, 0]],
      [[ORDER.TD, 0x00, 0x02, 0xc1, 0xc2], [ORDER.TD, 0x00, 0x02, 0xc1]]
    ]) {
      expect(run(ok!, []).r.senseCode, JSON.stringify(ok)).toBeUndefined();
      expect(run(short!, []).r.senseCode, JSON.stringify(short)).toBe(0x10050121);
    }
  });

  it("**長さが画面を超える TD は 0x10050121 でその場で戻り、CC2 も落とす**（ACS は TD の位置で WTD を抜け、次の ESC が無いとして戻る——原典の読み）", () => {
    const { r, row5 } = run([ORDER.TD, 0x07, 0x81, 0xc1]); // 1921 バイト（24×80＋1）
    expect(r.senseCode).toBe(0x10050121);
    expect(row5).toBe("AB");
    expect(r.alarm).toBe(false);
    expect(r.messageWaiting).toBeUndefined();
  });

  it("誤りの前の IC はカーソルに効く（ACS も WTD の終わりの確定は走る）", () => {
    const { r, buf } = run([ORDER.IC, 7, 3, ORDER.SBA, 30, 2]);
    expect(r.senseCode).toBe(0x10050122);
    expect(buf.cursorAddr).toBe(buf.addrOf(7, 3));
  });

  it("正しいオーダーなら否定応答にしない（境界: 24 行 80 桁・RA の同じ位置・EA の長さ 2 と 5・SOH の長さ 1 と 7）", () => {
    for (const order of [
      [ORDER.SBA, 24, 80],
      [ORDER.RA, 5, 4, 0x5c],
      [ORDER.EA, 6, 2, 0x02, 0x00],
      [ORDER.EA, 6, 2, 0x05, 0x00, 0x01, 0x02, 0x03],
      [ORDER.SOH, 0x01, 0x00],
      [ORDER.SOH, 0x07, 0, 0, 0, 0, 0, 0, 0]
    ]) {
      expect(run(order).r.senseCode, JSON.stringify(order)).toBeUndefined();
    }
  });

  it("SBA の行 1・桁 0 は否定応答にしない（ACS は番地 -1 として受ける。当 PJ は受けられず従来どおり例外——backlog）", () => {
    expect(() => run([ORDER.SBA, 1, 0])).toThrow();
  });
});
