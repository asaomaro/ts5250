import { describe, it, expect } from "vitest";
import { applyDataStream } from "../src/protocol/wtd-applier.js";
import { buildReadMdtResponse, buildReadMdtAltResponse, buildReadInputFieldsResponse } from "../src/protocol/read-response.js";
import { parseRecord } from "../src/protocol/gds.js";
import { ScreenBuffer } from "../src/screen/buffer.js";
import { ESC, COMMAND, ORDER, AID } from "../src/protocol/constants.js";
import { codecForCcsid } from "@ts5250/ebcdic/codec";

/**
 * **未編集の DBCS 欄の欄データ**（`20260927-read-dbcs-fields`）。ACS `DS5250.sendAll` は DBCS の欄も**末尾の NUL だけ**を落とし（実空白は送る）、
 * 途中の NUL は 0x52 で 0x40・ALT（0x82・0x83）でそのまま送る。期待値は実機の ACS のコアが送ったバイト列（DSM の READDBCS。`scripts/acs-probe/read-dbcs-fields.txt`）
 */
const codec = codecForCcsid(930);
const hex = (b: Uint8Array): string => [...b].map((x) => x.toString(16).padStart(2, "0")).join("");

/** DSM の READDBCS と同じ 7 欄（MDT を立てた O・O・O・G・G・J・E） */
const SCREEN = Uint8Array.from([
  ESC, COMMAND.CLEAR_UNIT, ESC, COMMAND.WRITE_TO_DISPLAY, 0x00, 0x00,
  ORDER.SBA, 5, 9, ORDER.SF, 0x48, 0x00, 0x82, 0x80, 0x24, 0x00, 0x0c,
  0x0e, 0x44, 0x82, 0x0f, 0x40, 0x40, 0x40, 0x40, 0x40, 0x40, 0x40, 0x40,
  ORDER.SBA, 7, 9, ORDER.SF, 0x48, 0x00, 0x82, 0x80, 0x24, 0x00, 0x0c,
  0x0e, 0x44, 0x82, 0x0f, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
  ORDER.SBA, 9, 9, ORDER.SF, 0x48, 0x00, 0x82, 0x80, 0x24, 0x00, 0x0c,
  0x0e, 0x44, 0x82, 0x0f, 0x00, 0xc1, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
  ORDER.SBA, 11, 9, ORDER.SF, 0x48, 0x00, 0x82, 0x20, 0x24, 0x00, 0x08,
  0x44, 0x82, 0x40, 0x40, 0x40, 0x40, 0x40, 0x40,
  ORDER.SBA, 13, 9, ORDER.SF, 0x48, 0x00, 0x82, 0x20, 0x24, 0x00, 0x08,
  0x44, 0x82, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
  ORDER.SBA, 15, 9, ORDER.SF, 0x48, 0x00, 0x82, 0x00, 0x24, 0x00, 0x0c,
  0x0e, 0x44, 0x82, 0x40, 0x40, 0x40, 0x40, 0x40, 0x40, 0x40, 0x40, 0x0f,
  ORDER.SBA, 17, 9, ORDER.SF, 0x48, 0x00, 0x82, 0x40, 0x24, 0x00, 0x0c,
  0x0e, 0x44, 0x82, 0x0f, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
  // NUL だけの G・O（ACS は 0 バイト）
  ORDER.SBA, 19, 9, ORDER.SF, 0x48, 0x00, 0x82, 0x20, 0x24, 0x00, 0x08,
  0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
  ORDER.SBA, 21, 9, ORDER.SF, 0x48, 0x00, 0x82, 0x80, 0x24, 0x00, 0x0c,
  0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00
]);

/** 応答を欄ごとのデータに分ける（SBA で区切る。行・桁・AID の 3 バイトの後ろ） */
function fieldData(record: Uint8Array): string[] {
  const data = parseRecord(record).data.subarray(3);
  const out: string[] = [];
  let i = 0;
  while (i < data.length) {
    expect(data[i]).toBe(ORDER.SBA);
    let j = i + 3;
    while (j < data.length && data[j] !== ORDER.SBA) j++;
    out.push(hex(data.subarray(i + 3, j)));
    i = j;
  }
  return out;
}

function screen() {
  const buf = new ScreenBuffer();
  applyDataStream(SCREEN, buf, codec, () => {});
  return buf;
}

/**
 * G の欄の字の符号は実機のワイヤで `4562`（ACS も当 PJ も。`scripts/verify-read-dbcs-fields.mjs`）。この単体はホストの WTD を通さず `4482` のまま載せるので、
 * 期待値の G の組は `G` に置き換えて比べる（見るのは NUL・実空白・詰めの規則）
 */
const G = "4482";
const gOf = (want: string[]) => want.map((x) => x.replace(/^4562/, G));

describe("未編集の DBCS 欄の欄データ（ACS の実測）", () => {
  it("**0x52**: 末尾の実空白は送り、末尾の NUL だけ落とす。途中の NUL は 0x40。G は詰めない", () => {
    expect(fieldData(buildReadMdtResponse(screen(), codec, AID.ENTER, { row: 5, col: 10 }).record)).toEqual(gOf([
      "0e44820f4040404040404040", "0e44820f", "0e44820f40c1", "4562404040404040", "4562", "0e448240404040404040400f", "0e44820f", "", ""
    ]));
  });

  it("**ALT（0x82）**: 途中の NUL もそのまま", () => {
    expect(fieldData(buildReadMdtAltResponse(screen(), codec, AID.ENTER, { row: 5, col: 10 }).record)).toEqual(gOf([
      "0e44820f4040404040404040", "0e44820f", "0e44820f00c1", "4562404040404040", "4562", "0e448240404040404040400f", "0e44820f", "", ""
    ]));
  });

  /**
   * **継続欄は連結した後の末尾だけを見る**（ACS `FFT5250.getFieldContents` が全区間を連結し、`sendAll` が末尾の NUL を落とす）。
   * 先頭の区間の末尾の NUL は途中の NUL になる（0x52 は 0x40・ALT は 0x00）。区間ごとに落とすと 2 区間目の字が前へ詰まる
   */
  it("**継続欄（O）**: 1 区間目の末尾の NUL は落とさず、連結した末尾だけ落とす", () => {
    const run = Uint8Array.from([
      ESC, COMMAND.CLEAR_UNIT, ESC, COMMAND.WRITE_TO_DISPLAY, 0x00, 0x00,
      ORDER.SBA, 5, 9, ORDER.SF, 0x48, 0x00, 0x82, 0x80, 0x86, 0x01, 0x24, 0x00, 0x06,
      0x0e, 0x44, 0x82, 0x0f, 0x00, 0x00,
      ORDER.SBA, 7, 9, ORDER.SF, 0x40, 0x00, 0x82, 0x80, 0x86, 0x02, 0x24, 0x00, 0x06,
      0x0e, 0x44, 0x83, 0x0f, 0x00, 0x00
    ]);
    const buf = new ScreenBuffer();
    applyDataStream(run, buf, codec, () => {});
    expect(fieldData(buildReadMdtResponse(buf, codec, AID.ENTER, { row: 5, col: 10 }).record)).toEqual(["0e44820f40400e44830f"]);
    expect(fieldData(buildReadMdtAltResponse(buf, codec, AID.ENTER, { row: 5, col: 10 }).record)).toEqual(["0e44820f00000e44830f"]);
  });

  it("編集した DBCS 欄は従来どおり（論理値を codec が付け直す）", () => {
    const buf = screen();
    const o = buf.orderedFields()[0]!;
    buf.setFieldValue(o, "い");
    const [first] = fieldData(buildReadMdtResponse(buf, codec, AID.ENTER, { row: 5, col: 10 }).record);
    expect(first).toBe(hex(codec.encode("い").bytes));
  });
});

/**
 * **平坦な形（0x42・0x72）の符号付き数値**: 符号の手前の桁が数字でなくてもゾーンを 0xD にする（ACS `sendAll` の case 66・114 は 0x52 と同じ文。
 * 0x52 の同じ文は実機で `     -` → `40404040d0`。`20260927-read-dbcs-fields`）
 */
describe("平坦な形の符号付き数値", () => {
  it("**`     -` は `40404040d0`**（手前が空白でも畳む）・`    A-` は `40404040d1`", () => {
    const buf = new ScreenBuffer();
    applyDataStream(Uint8Array.from([
      ESC, COMMAND.CLEAR_UNIT, ESC, COMMAND.WRITE_TO_DISPLAY, 0x00, 0x00,
      ORDER.SBA, 5, 9, ORDER.SF, 0x4f, 0x00, 0x24, 0x00, 0x06, 0x40, 0x40, 0x40, 0x40, 0x40, 0x60,
      ORDER.SBA, 7, 9, ORDER.SF, 0x4f, 0x00, 0x24, 0x00, 0x06, 0x40, 0x40, 0x40, 0x40, 0xc1, 0x60
    ]), buf, codec, () => {});
    const data = parseRecord(buildReadInputFieldsResponse(buf, codec, AID.ENTER, { row: 5, col: 10 }).record).data;
    expect(hex(data.subarray(3))).toBe("40404040d0" + "40404040d1");
  });
});
