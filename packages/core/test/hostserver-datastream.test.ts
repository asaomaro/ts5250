import { describe, it, expect } from "vitest";
import {
  buildRequest,
  parseReply,
  findParam,
  findUint,
  uintParam,
  CP,
  REQREP,
  SERVER_ID,
  HEADER_LEN
} from "../src/hostserver/datastream.js";
import { Tn5250Error } from "../src/errors.js";

/**
 * ホストサーバーのデータストリームは 20 バイトヘッダー＋LL/CP。
 * 実機の応答を写した固定バイト列で解析を、往復で組み立てを検証する。
 */

/** research で PUB400 から実際に受け取った交換属性応答（seed とジョブ名を含む） */
const REAL_REPLY = Buffer.from(
  "0000005e0000e0090000000000000000" +
    "0004f003000000000000000a11010007" +
    "0500000000081102000f0000000e1103" +
    "2fa8c1f7f1ce7ce50000000711190300" +
    "00001f111f00000000f6f5f7f0f0f761" +
    "d8e4e2c5d961d8e9e2d6e2c9c7d5",
  "hex"
);

describe("buildRequest", () => {
  it("ヘッダーに全体長・サーバーID・ReqRep を書く", () => {
    const req = buildRequest({
      serverId: SERVER_ID.signon,
      reqRep: REQREP.signonExchangeAttributes,
      params: [uintParam(CP.version, 1, 4)]
    });
    const v = new DataView(req.buffer);
    expect(req.length).toBe(HEADER_LEN + 6 + 4);
    expect(v.getUint32(0)).toBe(req.length);
    expect(v.getUint16(6)).toBe(0xe009);
    expect(v.getUint16(16)).toBe(0); // template 長
    expect(v.getUint16(18)).toBe(0x7003);
  });

  it("template は ReqRep の直後に置かれ、長さがヘッダーに載る", () => {
    const req = buildRequest({
      serverId: SERVER_ID.signon,
      reqRep: REQREP.signonInfo,
      template: new Uint8Array([3]),
      params: []
    });
    expect(new DataView(req.buffer).getUint16(16)).toBe(1);
    expect(req[HEADER_LEN]).toBe(3);
  });

  it("交換属性要求は 52 バイトになる（実機が受け付けた長さ）", () => {
    const req = buildRequest({
      serverId: SERVER_ID.signon,
      reqRep: REQREP.signonExchangeAttributes,
      params: [
        uintParam(CP.version, 1, 4),
        uintParam(CP.datastreamLevel, 2, 2),
        { cp: CP.seed, value: new Uint8Array(8) }
      ]
    });
    expect(req.length).toBe(52);
  });
});

describe("parseReply", () => {
  it("実機の応答からパラメータを取り出す", () => {
    const r = parseReply(new Uint8Array(REAL_REPLY));
    expect(r.returnCode).toBe(0);
    expect(findUint(r, CP.version)).toBe(0x00070500);
    expect(findUint(r, CP.datastreamLevel)).toBe(15);
    expect(findUint(r, CP.passwordLevel)).toBe(3);
    expect(Buffer.from(findParam(r, CP.seed)!).toString("hex")).toBe("2fa8c1f7f1ce7ce5");
  });

  it("組み立てた応答を解析できる（往復）", () => {
    // 応答は戻りコード 4 バイトを template として運ぶ。要求と違いパラメータは 24 から始まる
    const seed = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
    const frame = buildRequest({
      serverId: SERVER_ID.signon,
      reqRep: REQREP.signonExchangeAttributes | 0x8000,
      template: new Uint8Array([0, 0, 0, 0]),
      params: [uintParam(CP.datastreamLevel, 2, 2), { cp: CP.seed, value: seed }]
    });
    const r = parseReply(frame);
    expect(r.returnCode).toBe(0);
    expect(findUint(r, CP.datastreamLevel)).toBe(2);
    expect(findParam(r, CP.seed)).toEqual(seed);
  });

  it("パラメータ開始位置を 24 決め打ちにせず template 長から求める", () => {
    // template 長 8（戻りコード 4 ＋ 予備 4）でもパラメータを正しく読める
    const frame = buildRequest({
      serverId: SERVER_ID.signon,
      reqRep: REQREP.signonInfo | 0x8000,
      template: new Uint8Array([0, 0, 0, 0, 0xaa, 0xbb, 0xcc, 0xdd]),
      params: [uintParam(CP.serverCcsid, 273, 4)]
    });
    const r = parseReply(frame);
    expect(r.returnCode).toBe(0);
    expect(findUint(r, CP.serverCcsid)).toBe(273);
  });

  it("template に戻りコードが入らない応答を拒否する", () => {
    const bad = new Uint8Array(24);
    const v = new DataView(bad.buffer);
    v.setUint32(0, 24);
    v.setUint16(16, 2); // 戻りコード 4 バイトに足りない
    expect(() => parseReply(bad)).toThrow(/no return code/);
  });

  it("無い CP は undefined を返す", () => {
    expect(findParam(parseReply(new Uint8Array(REAL_REPLY)), 0x9999)).toBeUndefined();
    expect(findUint(parseReply(new Uint8Array(REAL_REPLY)), 0x9999)).toBeUndefined();
  });

  it("短すぎる応答を拒否する", () => {
    expect(() => parseReply(new Uint8Array(10))).toThrow(Tn5250Error);
    expect(() => parseReply(new Uint8Array(10))).toThrow(/too short/);
  });

  it("宣言長と実長の不一致を拒否する", () => {
    const bad = new Uint8Array(24);
    new DataView(bad.buffer).setUint32(0, 999);
    expect(() => parseReply(bad)).toThrow(/length mismatch/);
  });

  it("LL が 6 未満なら例外にする（無限ループ防止）", () => {
    const bad = new Uint8Array(30);
    const v = new DataView(bad.buffer);
    v.setUint32(0, 30);
    v.setUint16(16, 4); // template = 戻りコード
    v.setUint32(24, 3); // LL=3 は自身の 6 バイトすら満たさない
    expect(() => parseReply(bad)).toThrow(/bad LL/);
  });

  it("フレームをはみ出すパラメータを拒否する", () => {
    const bad = new Uint8Array(30);
    const v = new DataView(bad.buffer);
    v.setUint32(0, 30);
    v.setUint16(16, 4);
    v.setUint32(24, 100);
    expect(() => parseReply(bad)).toThrow(/overruns frame/);
  });

  it("末尾に 6 バイト未満の端数があっても落ちない", () => {
    const buf = new Uint8Array(24 + 6 + 2);
    const v = new DataView(buf.buffer);
    v.setUint32(0, buf.length);
    v.setUint16(16, 4);
    v.setUint32(24, 6);
    v.setUint16(28, CP.passwordLevel);
    const r = parseReply(buf);
    expect(r.params).toHaveLength(1);
  });
});

describe("findUint", () => {
  it("想定外の幅は例外にする", () => {
    const buf = new Uint8Array(24 + 6 + 3);
    const v = new DataView(buf.buffer);
    v.setUint32(0, buf.length);
    v.setUint16(16, 4);
    v.setUint32(24, 9);
    v.setUint16(28, CP.version);
    expect(() => findUint(parseReply(buf), CP.version)).toThrow(/unexpected width/);
  });
});

describe("VRM の解釈（version は上位 16 ビット）", () => {
  it("実機の 0x00070500 は V7R5M0（4 バイト分割の 0.7.5.0 ではない）", () => {
    const raw = 0x00070500;
    expect((raw >>> 16) & 0xffff).toBe(7);
    expect((raw >>> 8) & 0xff).toBe(5);
    expect(raw & 0xff).toBe(0);
  });
});
