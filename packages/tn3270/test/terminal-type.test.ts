import { describe, it, expect } from "vitest";
import {
  terminalTypeFor,
  alternateSizeFor,
  PRIMARY_SIZE,
  ALTERNATE_SIZE
} from "../src/telnet/terminal-type.js";

describe("端末タイプ名の組み立て（RFC 1576）", () => {
  it("既定は s3270 と同じ IBM-3279-2-E", () => {
    // research F3 実測: s3270 の既定モデルがこれで、Hercules も受理した
    expect(terminalTypeFor()).toBe("IBM-3279-2-E");
  });

  it("モデル・系列・拡張の有無を反映する", () => {
    expect(terminalTypeFor({ model: 5 })).toBe("IBM-3279-5-E");
    expect(terminalTypeFor({ family: "3278", model: 4 })).toBe("IBM-3278-4-E");
    // 3278 は拡張属性非対応（RFC 1576）。-E を外せる
    expect(terminalTypeFor({ family: "3278", model: 2, extended: false })).toBe("IBM-3278-2");
  });

  it("装置名は @ で付ける（基本 TN3270 の LU 指定の慣行）", () => {
    // research F1 実測: この形で TK4- の TCAM 端末 03C0 に繋がる
    expect(terminalTypeFor({ deviceName: "03C0" })).toBe("IBM-3279-2-E@03C0");
    expect(terminalTypeFor({ model: 4, extended: false, deviceName: "00C0" })).toBe(
      "IBM-3279-4@00C0"
    );
  });
});

describe("画面サイズ（RFC 1576: モデルは代替サイズを指す）", () => {
  it("標準サイズはモデルによらず 24x80", () => {
    expect(PRIMARY_SIZE).toEqual({ rows: 24, cols: 80 });
  });

  it("代替サイズはモデルごと", () => {
    expect(alternateSizeFor(2)).toEqual({ rows: 24, cols: 80 }); // 標準と同じ
    expect(alternateSizeFor(3)).toEqual({ rows: 32, cols: 80 });
    expect(alternateSizeFor(4)).toEqual({ rows: 43, cols: 80 });
    expect(alternateSizeFor(5)).toEqual({ rows: 27, cols: 132 });
  });

  it("既定モデルは 2", () => {
    expect(alternateSizeFor()).toEqual(ALTERNATE_SIZE[2]);
  });
});
