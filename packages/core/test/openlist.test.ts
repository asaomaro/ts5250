import { describe, it, expect } from "vitest";
import {
  padEbcdic,
  readEbcdic,
  codecOf,
  int32,
  concatBytes,
  parseListInfo
} from "../src/hostserver/list/openlist.js";
import type { CommandConnection } from "../src/hostserver/command/command-connection.js";
import { Tn5250Error } from "../src/errors.js";

/** QGY のオープンリスト API に共通する部分 */
describe("padEbcdic", () => {
  it("固定長で空白詰めし、大文字化する", () => {
    expect([...padEbcdic("ab", 4)]).toEqual([0xc1, 0xc2, 0x40, 0x40]);
  });

  it("長すぎる場合は切り詰める", () => {
    expect(padEbcdic("ABCDEF", 3)).toHaveLength(3);
  });

  it("CCSID 37 で表せない文字を拒否する", () => {
    expect(() => padEbcdic("日本語", 10)).toThrow(/not representable/);
  });
});

describe("readEbcdic", () => {
  it("末尾の空白を落とす", () => {
    const b = Uint8Array.from([0xc1, 0xc2, 0x40, 0x40]);
    expect(readEbcdic(b, 0, 4)).toBe("AB");
  });
});

describe("int32 / concatBytes", () => {
  it("符号付き 4 バイト", () => {
    expect([...int32(1)]).toEqual([0, 0, 0, 1]);
  });

  it("連結する", () => {
    expect([...concatBytes([int32(1), Uint8Array.from([9])])]).toEqual([0, 0, 0, 1, 9]);
  });

  it("空でも壊れない", () => {
    expect(concatBytes([])).toHaveLength(0);
  });
});

describe("parseListInfo", () => {
  function info(total: number, returned: number, recordLength: number): Uint8Array {
    const b = new Uint8Array(80);
    const v = new DataView(b.buffer);
    v.setInt32(0, total);
    v.setInt32(4, returned);
    v.setInt32(12, recordLength);
    return b;
  }

  it("件数とレコード長を読む", () => {
    expect(parseListInfo(info(248, 132, 62))).toEqual({
      total: 248,
      returned: 132,
      recordLength: 62
    });
  });

  it("短すぎるデータを拒否する", () => {
    expect(() => parseListInfo(new Uint8Array(8))).toThrow(Tn5250Error);
  });
});

/**
 * **リストが返す文字はジョブの CCSID で入っている。**
 *
 * 日本語機ではユーザーの説明などが DBCS（SO/SI ＋ 2 バイト）で返る。CCSID 37 で読むと
 * 1 バイトずつラテン文字に化けた（実機のユーザー一覧で「ä[äbäýäþ ãýáÄ」のように出た）。
 */
describe("codecOf — ジョブ CCSID でテキストを読む", () => {
  const conn = (ccsid: number) => ({ info: { ccsid } }) as unknown as CommandConnection;
  /** "日本" を CCSID 939 の DBCS で表したバイト列（SO + 2 バイト×2 + SI） */
  const NIHON = Uint8Array.from([0x0e, 0x45, 0x62, 0x45, 0x66, 0x0f]);

  it("日本語 CCSID なら DBCS として読める", () => {
    expect(readEbcdic(NIHON, 0, NIHON.length, codecOf(conn(939)))).toBe("日本");
  });

  it("CCSID 37 のままだとバイトごとに化ける（従来の挙動）", () => {
    const broken = readEbcdic(NIHON, 0, NIHON.length);
    expect(broken).not.toBe("日本");
    expect(broken.length).toBeGreaterThan(2); // 1 バイト 1 文字に割れる
  });

  it("未対応の CCSID は 37 にフォールバックする（落とさない）", () => {
    const b = Uint8Array.from([0xc1, 0xc2]);
    expect(readEbcdic(b, 0, 2, codecOf(conn(1234567)))).toBe("AB");
    expect(readEbcdic(b, 0, 2, codecOf(conn(0)))).toBe("AB");
  });
});
