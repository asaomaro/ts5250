import { describe, it, expect } from "vitest";
import { applyDataStream } from "../src/protocol/wtd-applier.js";
import { buildReadMdtResponse } from "../src/protocol/read-response.js";
import { parseRecord } from "../src/protocol/gds.js";
import { ScreenBuffer } from "../src/screen/buffer.js";
import { rawSentinel } from "../src/screen/attr-sentinel.js";
import { codecForCcsid } from "@ts5250/ebcdic/codec";
import { ESC, COMMAND, ORDER, AID } from "../src/protocol/constants.js";

/**
 * **数値専用の欄の Field− のゾーン D がそのままホストへ届く**（`20260921-field-minus-zone-d`）。web-ui は最終桁を生バイト（センチネル）で
 * 持ち、送信時の検証はセンチネルを型検査から外し、READ MDT の応答が生バイト 1 つとして書く。ACS は同じ欄で `F1 F2 40 40 40 D0` を送る
 * （未入力の NUL は READ MDT では空白になる。最終桁は 0x00 → 0xD0）
 */
const codec = codecForCcsid(37);

describe("数値専用の欄のゾーン D", () => {
  it("`12` と Field− の値（最終桁 0xD0）が `F1 F2 40 40 40 D0` で送られる", () => {
    const b = new ScreenBuffer();
    // 5,10 から 6 桁の数値専用（FFW 0x4300）
    applyDataStream(Uint8Array.from([ESC, COMMAND.WRITE_TO_DISPLAY, 0x00, 0x00, ORDER.SBA, 5, 9, ORDER.SF, 0x43, 0x00, 0x24, 0x00, 0x06]), b, codec);
    const f = b.fieldAt(5, 10);
    b.setFieldValue(f, "12   " + rawSentinel(0xd0));
    const { record } = buildReadMdtResponse(b, codec, AID.ENTER, { row: 5, col: 10 });
    const d = [...parseRecord(record).data].slice(3);
    expect(d.slice(0, 3)).toEqual([ORDER.SBA, 5, 10]);
    expect(Buffer.from(d.slice(3)).toString("hex")).toBe("f1f2404040d0");
  });
});
