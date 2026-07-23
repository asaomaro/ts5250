import { describe, it, expect } from "vitest";
import {
  parseStartupResponse,
  startupCodeMeaning,
  STARTUP_SUCCESS_CODES
} from "../src/telnet/startup-record.js";
import { codecForCcsid } from "../src/codec/codec.js";

/**
 * 起動応答レコード（RFC 4777 §10）。
 *
 * **バイト列は実機（PUB400）で捕えたもの**——装置名を指定せず接続したときの 1 レコード目。
 * ここから「実際に割り当てられた装置名」が分かるので、画面に触れずにジョブ名を知れる。
 */
const codec = codecForCcsid(37);

/** 実機の 1 レコード目（73 バイト）。I902 / PUB400 / QPADEV001P */
const REAL_RECORD = Uint8Array.from([
  0x00, 0x49, 0x12, 0xa0, 0x90, 0x00, 0x05, 0x60, 0x06, 0x00, 0x20, 0xc0, 0x00, 0x3d, 0x00, 0x00,
  0xc9, 0xf9, 0xf0, 0xf2, // "I902"
  0xd7, 0xe4, 0xc2, 0xf4, 0xf0, 0xf0, 0x40, 0x40, // "PUB400  "
  0xd8, 0xd7, 0xc1, 0xc4, 0xc5, 0xe5, 0xf0, 0xf0, 0xf1, 0xd7, // "QPADEV001P"
  ...new Array<number>(73 - 38).fill(0)
]);

describe("起動応答レコード", () => {
  it("実機のレコードから 応答コード・システム名・装置名 を取る", () => {
    expect(parseStartupResponse(REAL_RECORD, codec)).toEqual({
      code: "I902",
      system: "PUB400",
      device: "QPADEV001P"
    });
  });

  /**
   * **通常のデータストリームを食べないこと。**
   * 誤って起動応答と判定すると、そのレコードが画面へ流れず画面が出なくなる。
   */
  it("応答コードの形をしていないレコードは起動応答ではない", () => {
    // 実機の WTD レコード（0x12a0 ヘッダ・opcode 3）を模したもの
    const data = Uint8Array.from([
      0x00, 0x11, 0x12, 0xa0, 0x00, 0x00, 0x04, 0x00, 0x00, 0x03, 0x04, 0xf3, 0x00, 0x05, 0xd9,
      0x70, 0x00
    ]);
    expect(parseStartupResponse(data, codec)).toBeUndefined();
  });

  it("短すぎるレコードは undefined", () => {
    expect(parseStartupResponse(Uint8Array.from([0x00, 0x04, 0x12, 0xa0]), codec)).toBeUndefined();
  });

  /** プリンターは応答コードだけで可否を判断する。短い応答でも壊れないこと */
  it("応答コードだけの短い応答も読める（システム名・装置名は空）", () => {
    const short = Uint8Array.from([
      0x00, 0x13, 0x12, 0xa0, 0x90, 0x00, 0x04, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
      0xf8, 0xf9, 0xf0, 0xf2 // "8902"
    ]);
    expect(parseStartupResponse(short, codec)).toEqual({ code: "8902", system: "", device: "" });
  });

  it("成功コードと意味", () => {
    expect(STARTUP_SUCCESS_CODES.has("I902")).toBe(true);
    expect(STARTUP_SUCCESS_CODES.has("8902")).toBe(false);
    expect(startupCodeMeaning("8902")).toBe("Device not available.");
    expect(startupCodeMeaning("9999")).toBe("unknown startup response");
  });
});
