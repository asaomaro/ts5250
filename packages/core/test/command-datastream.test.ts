import { describe, it, expect } from "vitest";
import {
  COMMAND_SERVER_ID,
  CMD_REQ,
  MIN_DATASTREAM_LEVEL,
  RC_OK,
  RC_FAILED_WITH_MESSAGES,
  buildExchangeAttributesRequest,
  parseExchangeAttributesReply,
  buildRunCommandRequest,
  buildCallProgramRequest,
  paramMaxLength
} from "../src/hostserver/command/command-datastream.js";
import { Tn5250Error } from "../src/errors.js";

/** 実機（PUB400 / IBM i 7.5）が返した交換属性の応答 */
const REAL_EXCHANGE = Buffer.from(
  "000000240000e008000000000000000000108001000000000111f2f9f2f400070500000b",
  "hex"
);

describe("buildExchangeAttributesRequest", () => {
  const req = buildExchangeAttributesRequest();

  it("34 バイト・template 14 で組む", () => {
    expect(req).toHaveLength(34);
    const v = new DataView(req.buffer);
    expect(v.getUint32(0)).toBe(34);
    expect(v.getUint16(6)).toBe(COMMAND_SERVER_ID);
    expect(v.getUint16(16)).toBe(14);
    expect(v.getUint16(18)).toBe(CMD_REQ.exchangeAttributes);
  });

  it("クライアント CCSID は UTF-16BE(1200)", () => {
    expect(new DataView(req.buffer).getUint32(20)).toBe(1200);
  });

  it("NLV は CCSID 37 の EBCDIC（既定 2924）", () => {
    // "2924" = F2 F9 F2 F4
    expect([...req.subarray(24, 28)]).toEqual([0xf2, 0xf9, 0xf2, 0xf4]);
  });

  it("CCSID 37 で表せない NLV を拒否する", () => {
    expect(() => buildExchangeAttributesRequest("日本語")).toThrow(/not representable/);
  });
});

describe("parseExchangeAttributesReply（実機の応答）", () => {
  const info = parseExchangeAttributesReply(new Uint8Array(REAL_EXCHANGE));

  it("CCSID・NLV・版数・データストリームレベルを読む", () => {
    expect(info.ccsid).toBe(273);
    expect(info.nlv).toBe("2924");
    expect(info.version).toBe("V7R5M0");
    expect(info.datastreamLevel).toBe(11);
  });

  it("実機のレベルは対応範囲内", () => {
    expect(info.datastreamLevel).toBeGreaterThanOrEqual(MIN_DATASTREAM_LEVEL);
  });

  it("短すぎる応答を拒否する", () => {
    expect(() => parseExchangeAttributesReply(new Uint8Array(20))).toThrow(Tn5250Error);
  });

  it("戻りコードが 0 以外なら拒否する", () => {
    const bad = new Uint8Array(REAL_EXCHANGE);
    new DataView(bad.buffer).setUint16(20, 0x1234);
    expect(() => parseExchangeAttributesReply(bad)).toThrow(/exchange attributes failed/);
  });
});

describe("buildRunCommandRequest", () => {
  it("コマンドを UTF-16BE で載せる", () => {
    const req = buildRunCommandRequest("AB");
    const v = new DataView(req.buffer);
    expect(req).toHaveLength(31 + 4);
    expect(v.getUint16(16)).toBe(1); // template 長
    expect(v.getUint16(18)).toBe(CMD_REQ.runCommand);
    expect(v.getUint8(20)).toBe(4); // メッセージオプション（全件返却）
    expect(v.getUint32(21)).toBe(10 + 4); // パラメータ LL
    expect(v.getUint16(25)).toBe(0x1104);
    expect(v.getUint32(27)).toBe(1200);
    expect([...req.subarray(31)]).toEqual([0x00, 0x41, 0x00, 0x42]); // "AB"
  });

  it("長さが全体と整合する", () => {
    const req = buildRunCommandRequest("DSPLIB LIB(QGPL)");
    expect(new DataView(req.buffer).getUint32(0)).toBe(req.length);
  });

  it("空のコマンドを拒否する", () => {
    expect(() => buildRunCommandRequest("")).toThrow(/empty/);
  });
});

describe("buildCallProgramRequest", () => {
  const params = [
    { type: "out", length: 100 },
    { type: "in", data: Uint8Array.from([0, 0, 0, 100]) }
  ] as const;
  const req = buildCallProgramRequest("QUSRJOBI", "QSYS", params);

  it("template 23・プログラム名とライブラリを CCSID 37 で 10 バイト詰め", () => {
    const v = new DataView(req.buffer);
    expect(v.getUint16(16)).toBe(23);
    expect(v.getUint16(18)).toBe(CMD_REQ.callProgram);
    // "QSYS" + 空白 6 個
    expect([...req.subarray(30, 40)]).toEqual([0xd8, 0xe2, 0xe8, 0xe2, 0x40, 0x40, 0x40, 0x40, 0x40, 0x40]);
  });

  it("パラメータ数と長さを書く", () => {
    const v = new DataView(req.buffer);
    expect(v.getUint16(41)).toBe(2);
    // 出力パラメータは入力データを持たない → LL = 12
    expect(v.getUint32(43)).toBe(12);
    expect(v.getUint32(43 + 6)).toBe(100); // 最大長
  });

  it("全体長が整合する", () => {
    expect(new DataView(req.buffer).getUint32(0)).toBe(req.length);
  });

  it("10 文字を超えるプログラム名を拒否する", () => {
    expect(() => buildCallProgramRequest("TOOLONGNAME1", "QSYS", [])).toThrow(/too long/);
  });
});

describe("paramMaxLength（入力と出力の大きい方）", () => {
  it("種別ごとに求める", () => {
    expect(paramMaxLength({ type: "in", data: new Uint8Array(4) })).toBe(4);
    expect(paramMaxLength({ type: "out", length: 100 })).toBe(100);
    expect(paramMaxLength({ type: "inout", data: new Uint8Array(4), length: 100 })).toBe(100);
    expect(paramMaxLength({ type: "null" })).toBe(0);
  });
});

describe("戻りコードの定数", () => {
  it("0 が成功、0x0400 がメッセージ付き失敗", () => {
    expect(RC_OK).toBe(0);
    expect(RC_FAILED_WITH_MESSAGES).toBe(0x0400);
  });
});

describe("template 長を決め打ちしない（前段 signon D4 と同じ轍を踏まない）", () => {
  it("宣言された template 長が想定外なら明示的に失敗する", () => {
    const bad = new Uint8Array(REAL_EXCHANGE);
    new DataView(bad.buffer).setUint16(16, 20); // 16 ではない値
    expect(() => parseExchangeAttributesReply(bad)).toThrow(/unexpected exchange attributes template length/);
  });

  it("実機の応答は template 長 16", () => {
    expect(new DataView(REAL_EXCHANGE.buffer, REAL_EXCHANGE.byteOffset).getUint16(16)).toBe(16);
  });
});
