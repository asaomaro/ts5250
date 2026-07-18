import { describe, it, expect } from "vitest";
import {
  parseDbTemplate,
  buildDbTemplate,
  isDbTemplateError,
  DB_SERVER_ID,
  DB_REPLY_ID,
  DB_TEMPLATE_LEN,
  DB_REQ,
  ORS
} from "../src/hostserver/db/db-datastream.js";
import { parseReply, findParam, HEADER_LEN } from "../src/hostserver/datastream.js";
import { Tn5250Error } from "../src/errors.js";

/**
 * database は signon と同じ 20 バイトヘッダー ＋ 20 バイト template。
 * 既存 parseReply（template 長からパラメータ位置を求める）が流用できることも確かめる。
 */

/** 応答フレームを組み立てる（テスト用） */
function replyFrame(opts: {
  rcClass?: number;
  rcCode?: number;
  orsBitmap?: number;
  reqRep?: number;
  params?: { cp: number; value: number[] }[];
}): Uint8Array {
  const params = opts.params ?? [];
  const paramsLen = params.reduce((n, p) => n + 6 + p.value.length, 0);
  const total = HEADER_LEN + DB_TEMPLATE_LEN + paramsLen;
  const out = new Uint8Array(total);
  const v = new DataView(out.buffer);
  v.setUint32(0, total);
  v.setUint16(4, 0);
  v.setUint16(6, DB_SERVER_ID);
  v.setUint16(16, DB_TEMPLATE_LEN);
  v.setUint16(18, opts.reqRep ?? DB_REPLY_ID);
  v.setUint32(20, opts.orsBitmap ?? 0);
  v.setUint32(28, 0x00010001);
  v.setUint16(34, opts.rcClass ?? 0);
  v.setInt32(36, opts.rcCode ?? 0);
  let pos = HEADER_LEN + DB_TEMPLATE_LEN;
  for (const p of params) {
    v.setUint32(pos, 6 + p.value.length);
    v.setUint16(pos + 4, p.cp);
    out.set(p.value, pos + 6);
    pos += 6 + p.value.length;
  }
  return out;
}

describe("parseDbTemplate", () => {
  it("成功応答を解釈する", () => {
    const t = parseDbTemplate(replyFrame({}));
    expect(t.rcClass).toBe(0);
    expect(isDbTemplateError(t)).toBe(false);
    expect(t.returnOrsHandle).toBe(1);
  });

  it("rcClass が 0 以外はエラー", () => {
    const t = parseDbTemplate(replyFrame({ rcClass: 2, rcCode: -204 }));
    expect(isDbTemplateError(t)).toBe(true);
    expect(t.rcClass).toBe(2);
  });

  it("戻りコードは符号付きで読む（SQLCODE は負になりうる）", () => {
    expect(parseDbTemplate(replyFrame({ rcClass: 2, rcCode: -204 })).rcClassReturnCode).toBe(-204);
  });

  it("ORS bitmap を読む", () => {
    const t = parseDbTemplate(replyFrame({ orsBitmap: ORS.resultData | ORS.dataFormat }));
    expect(t.orsBitmap & ORS.resultData).toBeTruthy();
    expect(t.orsBitmap & ORS.sqlca).toBeFalsy();
  });

  it("短すぎるフレームを拒否する", () => {
    expect(() => parseDbTemplate(new Uint8Array(30))).toThrow(Tn5250Error);
    expect(() => parseDbTemplate(new Uint8Array(30))).toThrow(/too short/);
  });

  it("想定外の ReqRep ID を拒否する（応答は必ず 0x2800）", () => {
    expect(() => parseDbTemplate(replyFrame({ reqRep: 0x1234 }))).toThrow(/unexpected database reply id/);
  });
});

describe("既存 parseReply が database の 40 バイトヘッダーでも動く", () => {
  it("パラメータ列を template 長から正しく求める", () => {
    const frame = replyFrame({ params: [{ cp: 0x3813, value: [1, 2, 3, 4] }] });
    const reply = parseReply(frame);
    expect(findParam(reply, 0x3813)).toEqual(Uint8Array.from([1, 2, 3, 4]));
  });

  it("パラメータが無い応答でも壊れない", () => {
    expect(parseReply(replyFrame({})).params).toEqual([]);
  });
});

describe("buildDbTemplate", () => {
  it("20 バイトを返す", () => {
    expect(buildDbTemplate({ orsBitmap: 0, rpbHandle: 1, parameterCount: 0 })).toHaveLength(
      DB_TEMPLATE_LEN
    );
  });

  it("RPB ハンドルとパラメータ数を書く", () => {
    const t = buildDbTemplate({ orsBitmap: ORS.sendReplyImmediately, rpbHandle: 3, parameterCount: 2 });
    const v = new DataView(t.buffer);
    expect(v.getUint32(0) >>> 0).toBe(ORS.sendReplyImmediately >>> 0);
    expect(v.getUint32(8)).toBe(0x00010001);
    expect(v.getUint16(14)).toBe(3);
    expect(v.getUint16(18)).toBe(2);
  });

  it("組み立てた template を解釈し直せる（往復）", () => {
    const tmpl = buildDbTemplate({ orsBitmap: ORS.resultData, rpbHandle: 1, parameterCount: 0 });
    const frame = new Uint8Array(HEADER_LEN + DB_TEMPLATE_LEN);
    frame.set(tmpl, HEADER_LEN);
    const v = new DataView(frame.buffer);
    v.setUint32(0, frame.length);
    v.setUint16(16, DB_TEMPLATE_LEN);
    v.setUint16(18, DB_REPLY_ID);
    expect(parseDbTemplate(frame).orsBitmap >>> 0).toBe(ORS.resultData >>> 0);
  });
});

describe("定数", () => {
  it("database のサーバー ID は 0xE004（signon の 0xE009 と別）", () => {
    expect(DB_SERVER_ID).toBe(0xe004);
  });

  it("主要な要求 ID", () => {
    expect(DB_REQ.prepareAndDescribe).toBe(0x1803);
    expect(DB_REQ.openAndDescribe).toBe(0x1804);
    expect(DB_REQ.fetch).toBe(0x180b);
    expect(DB_REQ.closeCursor).toBe(0x180a);
  });
});
