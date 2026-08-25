import { describe, it, expect } from "vitest";
import { buildReadMdtResponse, buildReadInputFieldsResponse } from "../src/protocol/read-response.js";
import { applyDataStream } from "../src/protocol/wtd-applier.js";
import { parseRecord } from "../src/protocol/gds.js";
import { ScreenBuffer } from "../src/screen/buffer.js";
import { codecForCcsid } from "@ts5250/ebcdic/codec";
import { AID, ORDER, FFW, COMMAND, ESC } from "../src/protocol/constants.js";

/**
 * **CA キー（コマンド・アテンション）では欄データを送らない。**
 *
 * どのキーが CA かは **SOH オーダー（0x01）のヘッダ**でしか届かない——FFW にも SF にも無い。
 * 本体 5〜7 バイト目の 24 ビットが F24〜F1 に対応し、立っているキーでは欄データを送らない
 * （GNU tn5250 `send_data_for_aid_key`、tn5250j `dataIncluded[]`。2 実装でレイアウトが一致）。
 *
 * 【実機で分かった不具合】SOH を読み捨てていたため、`CA12(12)` の画面で打鍵してから F12 を
 * 押すと**欄データを送ってしまい、ホストのプログラムが値を受け取った**
 * （実機 IBM i 7.3・`ASAOLIB/KEYPGM`。`HOST RECEIVED` に打った値が出た）。
 * 「F12 で取り消したのに反映される」型の事故になる。
 *
 * 実機で採った SOH: `len=7 本体=[00 00 00 18 00 08 04]`（`CA03`/`CA12`/`CF06` の画面）
 * → エラー行 24、マスクは **F3 と F12 だけ**。
 */

const codec = codecForCcsid(37);
/** 実機（`ASAOLIB/KEYDSPF`）で採ったヘッダ本体。CA03 と CA12 が立つ */
const HEADER_CA03_CA12 = [0x00, 0x00, 0x00, 0x18, 0x00, 0x08, 0x04];

function makeBuffer(): ScreenBuffer {
  const b = new ScreenBuffer();
  b.setAttr(b.addrOf(3, 9), 0x20);
  b.addField(b.addrOf(3, 10), 5, FFW.ID_VALUE, 0x20);
  b.setFieldValue(b.fieldByIndex(1), "AAA");
  return b;
}
const dataOf = (record: Uint8Array): number[] => [...parseRecord(record).data];

describe("SOH のマスク（欄データを送らない AID キー）", () => {
  it("実機で採ったヘッダから F3 と F12 だけを読み取る", () => {
    const b = new ScreenBuffer();
    b.setHeaderData(HEADER_CA03_CA12);
    expect(b.sendsDataForAid(3)).toBe(false);
    expect(b.sendsDataForAid(12)).toBe(false);
    expect(b.sendsDataForAid(6)).toBe(true); // CF06 は立たない
    expect(b.sendsDataForAid(1)).toBe(true);
    expect(b.sendsDataForAid(24)).toBe(true);
  });

  it("24 ビットの並びは F24〜F17 / F16〜F9 / F8〜F1（各バイトは LSB が小さい番号）", () => {
    const b = new ScreenBuffer();
    b.setHeaderData([0, 0, 0, 24, 0x01, 0x00, 0x80]); // F17 と F8
    expect(b.sendsDataForAid(17)).toBe(false);
    expect(b.sendsDataForAid(8)).toBe(false);
    expect(b.sendsDataForAid(16)).toBe(true);
    expect(b.sendsDataForAid(7)).toBe(true);
  });

  it("**申告が無ければ全部送る**（ヘッダが 7 バイト未満・F キー以外・AID 0）", () => {
    const b = new ScreenBuffer();
    b.setHeaderData([0x00, 0x00, 0x00, 0x18]); // マスクを含まない短いヘッダ
    expect(b.sendsDataForAid(12)).toBe(true);
    expect(b.sendsDataForAid(undefined)).toBe(true); // Enter・Help・ロール等
  });

  it("データストリームの SOH からマスクが入る（読み捨てない）", () => {
    const b = new ScreenBuffer();
    applyDataStream(
      Uint8Array.from([ESC, COMMAND.WRITE_TO_DISPLAY, 0x00, 0x20, ORDER.SOH, 0x07, ...HEADER_CA03_CA12]),
      b,
      codec,
      () => {}
    );
    expect(b.sendsDataForAid(12)).toBe(false);
    expect(b.sendsDataForAid(6)).toBe(true);
  });

  it("CLEAR UNIT で申告を捨てる（次の画面の SOH まで「送る」側へ戻す）", () => {
    const b = new ScreenBuffer();
    b.setHeaderData(HEADER_CA03_CA12);
    b.clearUnit();
    expect(b.sendsDataForAid(12)).toBe(true);
  });
});

describe("応答（0x52 / 0x42）でマスクが効く", () => {
  it("**CA キー（F12）はカーソル位置と AID だけ**——欄を 1 つも送らない", () => {
    const b = makeBuffer();
    b.setHeaderData(HEADER_CA03_CA12);
    const d = dataOf(buildReadMdtResponse(b, codec, AID.F12, { row: 3, col: 10 }).record);
    expect(d).toEqual([3, 10, AID.F12]);
  });

  it("CF キー（F6）は従来どおり送る（対照）", () => {
    const b = makeBuffer();
    b.setHeaderData(HEADER_CA03_CA12);
    const d = dataOf(buildReadMdtResponse(b, codec, AID.F6, { row: 3, col: 10 }).record);
    expect(d.slice(0, 3)).toEqual([3, 10, AID.F6]);
    expect(d.slice(3, 6)).toEqual([ORDER.SBA, 3, 10]);
    expect(d.slice(6)).toEqual([...codec.encode("AAA").bytes]);
  });

  it("Enter は申告の対象外（常に送る）", () => {
    const b = makeBuffer();
    b.setHeaderData(HEADER_CA03_CA12);
    const d = dataOf(buildReadMdtResponse(b, codec, AID.ENTER, { row: 3, col: 10 }).record);
    expect(d.slice(3, 6)).toEqual([ORDER.SBA, 3, 10]);
  });

  it("平坦形式（0x42）でも CA キーでは欄を送らない", () => {
    const b = makeBuffer();
    b.setHeaderData(HEADER_CA03_CA12);
    const d = dataOf(buildReadInputFieldsResponse(b, codec, AID.F12, { row: 3, col: 10 }).record);
    expect(d).toEqual([3, 10, AID.F12]);
    const ok = dataOf(buildReadInputFieldsResponse(b, codec, AID.F6, { row: 3, col: 10 }).record);
    expect(ok).toHaveLength(3 + 5); // 欄長 5 ぶんそのまま
  });
});
