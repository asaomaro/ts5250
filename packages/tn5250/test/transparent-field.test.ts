import { describe, it, expect } from "vitest";
import { applyDataStream } from "../src/protocol/wtd-applier.js";
import {
  buildReadMdtResponse,
  buildReadMdtAltResponse,
  buildReadInputFieldsResponse,
  buildReadImmediateResponse,
  buildReadMdtImmediateAltResponse
} from "../src/protocol/read-response.js";
import { parseRecord } from "../src/protocol/gds.js";
import { ScreenBuffer } from "../src/screen/buffer.js";
import { ESC, COMMAND, ORDER, AID } from "../src/protocol/constants.js";
import { codecForCcsid } from "@ts5250/ebcdic/codec";

/**
 * **透過の欄（FCW 0x84xx）**（台帳「DS5250 の残り」）。ACS `DS5250.sendAll` は READ MDT 系で `11 行 桁 10 長さ(2) 生バイト`（ヌルも落とさない）、
 * READ INPUT 系でヌルを空白に換えずに欄長ぶん送る。期待値は実機の ACS のコアが送ったバイト列（DSM の TRANSP。`scripts/acs-probe/transparent-field.txt`）:
 * `11050a 10 0008 c1c2e70000000000` ＋ `11070a c3c4e8`
 */
const codec = codecForCcsid(930);
const hex = (b: Uint8Array): string => [...b].map((x) => x.toString(16).padStart(2, "0")).join("");

/** DSM の TRANSP と同じ画面: (5,10) 透過の 8 桁 `AB`＋ヌル / (7,10) 素の 6 桁 `CD`＋ヌル */
function screen(fcw = [0x84, 0x00]): ScreenBuffer {
  const buf = new ScreenBuffer();
  applyDataStream(
    Uint8Array.from([
      ESC, COMMAND.CLEAR_UNIT, ESC, COMMAND.WRITE_TO_DISPLAY, 0x00, 0x00,
      ORDER.SBA, 5, 9, ORDER.SF, 0x40, 0x00, ...fcw, 0x20, 0x00, 0x08, 0xc1, 0xc2,
      ORDER.SBA, 7, 9, ORDER.SF, 0x40, 0x00, 0x20, 0x00, 0x06, 0xc3, 0xc4
    ]),
    buf,
    codec,
    () => {}
  );
  // 利用者が 3 桁目に X・Y を打った（ACS の測定と同じ）
  const [t, n] = buf.orderedFields();
  buf.setFieldValue(t!, "ABX");
  buf.setFieldValue(n!, "CDY");
  return buf;
}

const data = (record: Uint8Array): string => hex(parseRecord(record).data.subarray(3));

describe("透過の欄（FCW 0x84xx）", () => {
  it("**READ MDT（0x52）は 0x10・長さ・ヌルも含む生バイト**（ACS の実測と同じ）", () => {
    expect(data(buildReadMdtResponse(screen(), codec, AID.ENTER, { row: 7, col: 13 }).record)).toBe(
      "11050a" + "100008" + "c1c2e70000000000" + "11070a" + "c3c4e8"
    );
  });

  it("READ MDT ALT（0x82）も同じ形", () => {
    expect(data(buildReadMdtAltResponse(screen(), codec, AID.ENTER, { row: 7, col: 13 }).record)).toBe(
      "11050a" + "100008" + "c1c2e70000000000" + "11070a" + "c3c4e8"
    );
  });

  it("**下位バイトを問わず 0x84 なら透過**（ACS は FCW の上位バイトで振り分ける）", () => {
    expect(data(buildReadMdtResponse(screen([0x84, 0x7f]), codec, AID.ENTER, { row: 7, col: 13 }).record)).toBe(
      "11050a" + "100008" + "c1c2e70000000000" + "11070a" + "c3c4e8"
    );
  });

  it("**READ INPUT（0x42）はヌルを空白に換えず欄長ぶん**（素の欄はヌルを 0x40）", () => {
    expect(data(buildReadInputFieldsResponse(screen(), codec, AID.ENTER, { row: 7, col: 13 }).record)).toBe(
      "c1c2e70000000000" + "c3c4e8404040"
    );
  });

  it("READ MDT IMMEDIATE ALT（0x83）は欄の形、READ IMMEDIATE（0x72）は平たい形", () => {
    expect(data(buildReadMdtImmediateAltResponse(screen(), codec).record)).toBe(
      "11050a" + "100008" + "c1c2e70000000000" + "11070a" + "c3c4e8"
    );
    expect(data(buildReadImmediateResponse(screen(), codec).record)).toBe("c1c2e70000000000" + "c3c4e8404040");
  });

  it("透過でない欄は従来どおり（末尾のヌルを落とす）", () => {
    expect(data(buildReadMdtResponse(screen([0x82, 0x80]), codec, AID.ENTER, { row: 7, col: 13 }).record)).toBe(
      "11050a" + "c1c2e7" + "11070a" + "c3c4e8"
    );
  });
});

describe("透過の欄に DBCS の原本があるとき", () => {
  it("**桁ごとに原本のバイトで送る**（`fieldValue` は末尾を落とすので桁と合わない）", () => {
    const buf = new ScreenBuffer();
    applyDataStream(
      Uint8Array.from([
        ESC, COMMAND.CLEAR_UNIT, ESC, COMMAND.WRITE_TO_DISPLAY, 0x00, 0x00,
        ORDER.SBA, 5, 9, ORDER.SF, 0x48, 0x00, 0x84, 0x00, 0x20, 0x00, 0x08, 0x0e, 0x44, 0x82, 0x0f, 0x40, 0x40
      ]),
      buf,
      codec,
      () => {}
    );
    expect(data(buildReadMdtResponse(buf, codec, AID.ENTER, { row: 5, col: 10 }).record)).toBe(
      "11050a" + "100008" + "0e44820f40400000"
    );
  });
});

describe("透過の欄のセルの元のバイト・継続欄", () => {
  const apply = (bytes: number[]): ScreenBuffer => {
    const buf = new ScreenBuffer();
    applyDataStream(Uint8Array.from([ESC, COMMAND.CLEAR_UNIT, ESC, COMMAND.WRITE_TO_DISPLAY, 0x00, 0x00, ...bytes]), buf, codec, () => {});
    return buf;
  };

  it("**0x1C のセルは 0x1C のまま**（符号化し直すと `*` の 0x5C になる。ACS は HostPlane をそのまま送る）", () => {
    const buf = apply([ORDER.SBA, 5, 9, ORDER.SF, 0x48, 0x00, 0x84, 0x00, 0x20, 0x00, 0x04, 0xc1, 0x1c, 0xc2]);
    expect(data(buildReadMdtResponse(buf, codec, AID.ENTER, { row: 5, col: 10 }).record)).toBe("11050a" + "100004" + "c11cc200");
  });

  it("**継続欄は全区間を連結**し、長さは合計（ACS `getFieldContents`）", () => {
    const buf = apply([
      ORDER.SBA, 5, 9, ORDER.SF, 0x48, 0x00, 0x86, 0x01, 0x84, 0x00, 0x20, 0x00, 0x03, 0xc1, 0xc2,
      ORDER.SBA, 5, 14, ORDER.SF, 0x48, 0x00, 0x86, 0x02, 0x84, 0x00, 0x20, 0x00, 0x03, 0xc3
    ]);
    expect(data(buildReadMdtResponse(buf, codec, AID.ENTER, { row: 5, col: 10 }).record)).toBe("11050a" + "100006" + "c1c200c30000");
  });
});
