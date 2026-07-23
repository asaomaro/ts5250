import { describe, it, expect } from "vitest";
import {
  NP_SERVER_ID,
  NP_TEMPLATE_LEN,
  NP_CODEPOINT_OFFSET,
  NP_ACTION,
  NP_CP,
  NP_ATTR,
  NP_ATTR_LEN,
  NP_RC,
  buildAttributeList,
  buildNpRequest,
  parseNpReply,
  findCodePoint,
  padEbcdic
} from "../src/hostserver/spool/netprint-datastream.js";
import { Tn5250Error } from "../src/errors.js";

/**
 * 実機で判明した規則を固定する。いずれも推測で組んで失敗した箇所:
 *   - エントリは 長さ(4) → オフセット(4) の順（逆にすると値が空で届く）
 *   - 値オフセットはコードポイントヘッダー 6 バイトを含む
 *   - 文字列は固定長で空白詰め（詰めないと隣の値を巻き込む）
 *   - コードポイント ID は原典の値（ハンドルは 0x000C）
 */
describe("buildAttributeList", () => {
  const attrs = [
    { id: NP_ATTR.jobName, type: "string", value: "QPRTJOB", length: 10 },
    { id: NP_ATTR.spooledFileNumber, type: "int", value: 5 }
  ] as const;
  const data = buildAttributeList(attrs);

  it("件数と要素長を先頭に書く", () => {
    const v = new DataView(data.buffer);
    expect(v.getUint16(0)).toBe(2); // 属性 2 件
    expect(v.getUint16(2)).toBe(12); // エントリ長
  });

  it("エントリは 長さ(4) → オフセット(4) の順（逆にすると値が空で届く）", () => {
    const v = new DataView(data.buffer);
    expect(v.getUint16(4)).toBe(NP_ATTR.jobName);
    expect(v.getUint32(8)).toBe(10); // 長さが先
    // オフセットはコードポイントヘッダー 6 バイトを含む
    expect(v.getUint32(12)).toBe(4 + 12 * 2 + 6);
  });

  it("文字列を固定長で空白詰めする（詰めないと隣の値を巻き込む）", () => {
    const at = 4 + 12 * 2;
    const jobName = data.subarray(at, at + 10);
    expect(jobName).toHaveLength(10);
    // "QPRTJOB" + EBCDIC 空白 3 個
    expect([...jobName.subarray(7)]).toEqual([0x40, 0x40, 0x40]);
  });

  it("整数は 4 バイト", () => {
    const at = 4 + 12 * 2 + 10;
    expect(new DataView(data.buffer).getInt32(at)).toBe(5);
  });

  /**
   * **NUL 終端の文字列（stringz）。** メッセージ応答（MSGREPLY）はホストが末尾 NUL で
   * 長さを判断する。固定長の空白詰めで送ると応答が届かず、answerMessage が rc=0x0009 で
   * 失敗した（実機で確認）。JTOpen も文字列属性を new byte[len+1] にして末尾を 0 にしている。
   */
  it("stringz は EBCDIC ＋ 末尾 NUL（可変長）", () => {
    const d = buildAttributeList([{ id: NP_ATTR.messageReply, type: "stringz", value: "I" }]);
    const v = new DataView(d.buffer);
    expect(v.getUint16(0)).toBe(1);
    expect(v.getUint32(8), "長さは 2（'I' 1 + NUL 1）").toBe(2);
    const at = 4 + 12;
    expect([...d.subarray(at, at + 2)]).toEqual([0xc9, 0x00]); // EBCDIC 'I' + NUL
    // 型コードは文字列（int 以外）
    expect(v.getUint16(6)).toBe(0x0005);
  });

  it("stringz も大文字化する（固定長文字列と同じ規約）", () => {
    const d = buildAttributeList([{ id: NP_ATTR.messageReply, type: "stringz", value: "g" }]);
    const at = 4 + 12;
    expect([...d.subarray(at, at + 2)]).toEqual([0xc7, 0x00]); // 'G' + NUL
  });

  it("CCSID 37 で表せない値を拒否する", () => {
    expect(() =>
      buildAttributeList([{ id: NP_ATTR.jobName, type: "string", value: "日本語", length: 10 }])
    ).toThrow(/not representable/);
  });
});

describe("buildNpRequest", () => {
  const req = buildNpRequest({
    objectType: 0x0001,
    action: NP_ACTION.open,
    codePoints: [{ id: NP_CP.spooledFileId, data: Uint8Array.from([1, 2, 3, 4]) }]
  });

  it("20 バイトヘッダー ＋ 12 バイトテンプレート", () => {
    const v = new DataView(req.buffer);
    expect(v.getUint32(0)).toBe(req.length);
    expect(v.getUint16(6)).toBe(NP_SERVER_ID);
    expect(v.getUint16(16)).toBe(NP_TEMPLATE_LEN);
    expect(v.getUint16(20)).toBe(NP_ACTION.open); // 操作 ID
  });

  it("コードポイントは 32 バイト目から", () => {
    expect(NP_CODEPOINT_OFFSET).toBe(32);
    const v = new DataView(req.buffer);
    expect(v.getUint32(32)).toBe(6 + 4);
    expect(v.getUint16(36)).toBe(NP_CP.spooledFileId);
  });
});

describe("parseNpReply", () => {
  function reply(rc: number, cps: { id: number; data: number[] }[]): Uint8Array {
    const cpLen = cps.reduce((n, c) => n + 6 + c.data.length, 0);
    const out = new Uint8Array(NP_CODEPOINT_OFFSET + cpLen);
    const v = new DataView(out.buffer);
    v.setUint32(0, out.length);
    v.setUint16(6, NP_SERVER_ID);
    v.setUint16(16, NP_TEMPLATE_LEN);
    v.setUint16(26, rc);
    let pos = NP_CODEPOINT_OFFSET;
    for (const c of cps) {
      v.setUint32(pos, 6 + c.data.length);
      v.setUint16(pos + 4, c.id);
      out.set(c.data, pos + 6);
      pos += 6 + c.data.length;
    }
    return out;
  }

  it("戻りコードとコードポイントを取り出す", () => {
    const r = parseNpReply(reply(NP_RC.ok, [{ id: NP_CP.spooledFileHandle, data: [9, 9] }]));
    expect(r.returnCode).toBe(0);
    expect(findCodePoint(r, NP_CP.spooledFileHandle)).toEqual(Uint8Array.from([9, 9]));
  });

  it("ハンドルのコードポイントは 0x000C（0x0007 ではない）", () => {
    expect(NP_CP.spooledFileHandle).toBe(0x000c);
    expect(NP_CP.attributeList).toBe(0x0007);
  });

  it("読み終わりの戻りコードを区別できる", () => {
    expect(parseNpReply(reply(NP_RC.readEof, [])).returnCode).toBe(0x0013);
  });

  it("短すぎる応答を拒否する", () => {
    expect(() => parseNpReply(new Uint8Array(20))).toThrow(Tn5250Error);
  });

  it("LL が 6 未満なら打ち切る（無限ループ防止）", () => {
    const bad = new Uint8Array(NP_CODEPOINT_OFFSET + 10);
    new DataView(bad.buffer).setUint32(NP_CODEPOINT_OFFSET, 3);
    expect(parseNpReply(bad).codePoints).toEqual([]);
  });

  it("無い ID は undefined", () => {
    expect(findCodePoint(parseNpReply(reply(0, [])), 0x99)).toBeUndefined();
  });
});

describe("padEbcdic / 属性長", () => {
  it("空白詰めする", () => {
    expect([...padEbcdic("AB", 4)]).toEqual([0xc1, 0xc2, 0x40, 0x40]);
  });

  it("スプール識別の固定長（実機で必要だった値）", () => {
    expect(NP_ATTR_LEN.jobName).toBe(10);
    expect(NP_ATTR_LEN.jobUser).toBe(10);
    expect(NP_ATTR_LEN.jobNumber).toBe(6);
    expect(NP_ATTR_LEN.spooledFileName).toBe(10);
  });

  it("スプールファイル名の属性 ID は 0x0068", () => {
    expect(NP_ATTR.spooledFileName).toBe(0x0068);
  });
});
