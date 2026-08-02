import { describe, it, expect } from "vitest";
import { retrieveLob } from "../src/db/lob.js";
import type { DbConnection } from "../src/db/db-connection.js";

/**
 * **LOB の分割受信**（`20260802-lob-multi-segment`）。
 *
 * 1 応答に収まらない LOB は、開始オフセットを進めて何度も取る。
 * **ホストはその位置と要求量を「文字」で数える**——実機で確かめた
 * （`scripts/research-lob-multi-segment.mjs`）:
 *
 * ```
 * want=65535 offset=0      → lenField=65535 body=131070B   ← 要求 65535「文字」＝131070 バイト
 * want=65535 offset=131070 → lenField=65535 body=131070B   ← offset にバイトを入れていた
 * ```
 *
 * 2 周目の `offset` にバイト数（131,070）を入れると、ホストは**文字 131,070 目**
 * ＝バイト 262,140 目から読む。結果、**文字 65,535〜131,069 の 65,535 文字が丸ごと欠落**
 * した値に `too-large`（＝末尾で切れた、の意）が付いていた。**中抜けに気づけない。**
 *
 * ここでは**文字で数えるホスト**を模して、実機なしで回帰を止める。
 * この不具合は LOB の長さで踏んだ 3 度目の同じ罠で、いずれも
 * **SBCS で通ったから良し**としてすり抜けている——だから主役は 2 バイト CCSID にする。
 */

const CP = {
  locator: 0x3818,
  requestedSize: 0x3819,
  startOffset: 0x381a,
  dataLength: 0x3810,
  data: 0x380f
};

interface Ask {
  want: number;
  offset: number;
}

/**
 * **文字で数えるホスト**の代役。
 *
 * @param content 全体（バイト列）
 * @param ccsid   応答に載せる CCSID（1200 なら 2 バイト/文字）
 * @param opts.shortBy 応答本体を申告より短く返す（途中で切れた応答の再現）
 * @param opts.segmentUnits ホストが 1 応答で返す上限（文字）
 */
function charCountingHost(
  content: Uint8Array,
  ccsid: number,
  opts: { shortBy?: number; segmentUnits?: number } = {}
): { conn: DbConnection; asks: Ask[] } {
  const perChar = ccsid === 1200 ? 2 : 1;
  const totalUnits = Math.floor(content.length / perChar);
  const asks: Ask[] = [];
  const conn = {
    async request(o: { params?: { cp: number; value: Uint8Array }[] }) {
      const read = (cp: number): number => {
        const p = o.params?.find((x) => x.cp === cp);
        return p ? new DataView(p.value.buffer, p.value.byteOffset, p.value.byteLength).getUint32(0) : 0;
      };
      const want = read(CP.requestedSize);
      const offset = read(CP.startOffset);
      asks.push({ want, offset });

      // **ホストは文字で切り出す**
      const cap = opts.segmentUnits ?? Number.MAX_SAFE_INTEGER;
      const units = Math.max(0, Math.min(want, cap, totalUnits - offset));
      const from = offset * perChar;
      const give = Math.max(0, units * perChar - (opts.shortBy ?? 0));
      const body = content.subarray(from, from + give);

      const data = new Uint8Array(6 + body.length);
      const dv = new DataView(data.buffer);
      dv.setUint16(0, ccsid);
      // **申告するのは文字数**（バイト数ではない）
      dv.setUint32(2, units);
      data.set(body, 6);

      const len = new Uint8Array(6);
      const lv = new DataView(len.buffer);
      lv.setUint16(0, 4);
      lv.setUint32(2, totalUnits); // 総長も文字数

      return {
        dbTemplate: { rcClass: 0, rcClassReturnCode: 0 },
        params: [
          { cp: CP.dataLength, value: len },
          { cp: CP.data, value: data }
        ]
      };
    }
  } as unknown as DbConnection;
  return { conn, asks };
}

/** UTF-16BE のバイト列を作る（`あいうえおかきく` の繰り返し） */
function utf16(chars: number): Uint8Array {
  const seed = "あいうえおかきく";
  let s = "";
  while (s.length < chars) s += seed;
  s = s.slice(0, chars);
  const out = new Uint8Array(chars * 2);
  for (let i = 0; i < chars; i++) {
    out[i * 2] = s.charCodeAt(i) >> 8;
    out[i * 2 + 1] = s.charCodeAt(i) & 0xff;
  }
  return out;
}

/** ASCII のバイト列（`ABCDEFGH` の繰り返し） */
function ascii(bytes: number): Uint8Array {
  const out = new Uint8Array(bytes);
  for (let i = 0; i < bytes; i++) out[i] = 0x41 + (i % 8);
  return out;
}

const SEGMENT_UNITS = 0xffff;

describe("分割受信: 2 バイト CCSID（UTF-16）", () => {
  it("**先頭から連続して取れる**（中抜けしない）", async () => {
    // 実機と同じ形: 262,144 文字 = 524,288 バイト、上限 200,000 バイト
    const content = utf16(262_144);
    const { conn } = charCountingHost(content, 1200, { segmentUnits: SEGMENT_UNITS });
    const got = await retrieveLob(conn, 1, { maxBytes: 200_000 });
    // 取れた分は**先頭からの連続**でなければならない
    expect([...got.bytes]).toEqual([...content.subarray(0, got.bytes.length)]);
  });

  it("オフセットを**文字**で進める（バイトを入れると 2 倍飛ぶ）", async () => {
    const content = utf16(262_144);
    const { conn, asks } = charCountingHost(content, 1200, { segmentUnits: SEGMENT_UNITS });
    await retrieveLob(conn, 1, { maxBytes: 200_000 });
    expect(asks[0]).toMatchObject({ offset: 0 });
    // 1 周目で 65,535 文字（131,070 バイト）受け取ったので、次は **65,535 文字目**から
    expect(asks[1]?.offset).toBe(65_535);
  });

  it("**上限（バイト）を超えて保持しない**", async () => {
    const content = utf16(262_144);
    const { conn } = charCountingHost(content, 1200, { segmentUnits: SEGMENT_UNITS });
    const got = await retrieveLob(conn, 1, { maxBytes: 200_000 });
    expect(got.bytes.length).toBeLessThanOrEqual(200_000);
  });

  it("総長はバイトで返す（文字数のまま返さない）", async () => {
    const content = utf16(262_144);
    const { conn } = charCountingHost(content, 1200, { segmentUnits: SEGMENT_UNITS });
    const got = await retrieveLob(conn, 1, { maxBytes: 200_000 });
    expect(got.totalLength).toBe(524_288);
    expect(got.truncated).toBe(true);
  });

  it("全部収まるなら truncated は立たず、完全に一致する", async () => {
    const content = utf16(1_000); // 2,000 バイト
    const { conn } = charCountingHost(content, 1200, { segmentUnits: SEGMENT_UNITS });
    const got = await retrieveLob(conn, 1, { maxBytes: 64 * 1024 });
    expect(got.truncated).toBe(false);
    expect([...got.bytes]).toEqual([...content]);
  });

  it("小さなセグメントで何周しても連続する（境界を複数回跨ぐ）", async () => {
    const content = utf16(1_000);
    // 1 応答 7 文字ずつ＝143 周。**端数のある割り切れない刻み**にする
    const { conn, asks } = charCountingHost(content, 1200, { segmentUnits: 7 });
    const got = await retrieveLob(conn, 1, { maxBytes: 64 * 1024 });
    expect([...got.bytes]).toEqual([...content]);
    expect(asks.length).toBeGreaterThan(100);
  });
});

describe("分割受信: 上限での切り詰め", () => {
  it("**奇数バイトの上限でも符号単位を割らない**（UTF-16）", async () => {
    const content = utf16(1_000);
    const { conn } = charCountingHost(content, 1200, { segmentUnits: SEGMENT_UNITS });
    const got = await retrieveLob(conn, 1, { maxBytes: 101 });
    expect(got.bytes.length % 2).toBe(0);
    expect(got.bytes.length).toBeLessThanOrEqual(101);
    expect([...got.bytes]).toEqual([...content.subarray(0, got.bytes.length)]);
  });

  it("**孤立サロゲートを末尾に残さない**", async () => {
    // 𠀋（U+2000B）＝サロゲート対。ちょうど対の途中で切れる上限を与える
    const s = "\u{2000B}".repeat(10);
    const units = s.length; // 20 符号単位
    const content = new Uint8Array(units * 2);
    for (let i = 0; i < units; i++) {
      content[i * 2] = s.charCodeAt(i) >> 8;
      content[i * 2 + 1] = s.charCodeAt(i) & 0xff;
    }
    const { conn } = charCountingHost(content, 1200, { segmentUnits: SEGMENT_UNITS });
    // 6 バイト = 3 符号単位 → 対の途中。1 単位落として 4 バイト（2 対）になるはず
    const got = await retrieveLob(conn, 1, { maxBytes: 6 });
    expect(got.bytes.length).toBe(4);
  });

  it("SBCS では切り詰めが起きない（要求量が残量ちょうど）", async () => {
    const content = ascii(200_000);
    const { conn } = charCountingHost(content, 37, { segmentUnits: SEGMENT_UNITS });
    const got = await retrieveLob(conn, 1, { maxBytes: 100_000 });
    expect(got.bytes.length).toBe(100_000);
    expect([...got.bytes]).toEqual([...content.subarray(0, 100_000)]);
  });
});

describe("分割受信: SBCS / 混在は従来どおり", () => {
  it("バイト＝文字なので位置がずれない", async () => {
    const content = ascii(262_144);
    const { conn, asks } = charCountingHost(content, 5035, { segmentUnits: SEGMENT_UNITS });
    const got = await retrieveLob(conn, 1, { maxBytes: 200_000 });
    expect([...got.bytes]).toEqual([...content.subarray(0, 200_000)]);
    expect(asks[1]?.offset).toBe(65_535);
  });

  it("総長はそのままバイト（`* 1`）", async () => {
    const content = ascii(262_144);
    const { conn } = charCountingHost(content, 5035, { segmentUnits: SEGMENT_UNITS });
    const got = await retrieveLob(conn, 1, { maxBytes: 200_000 });
    expect(got.totalLength).toBe(262_144);
  });
});

describe("分割受信: 異常系", () => {
  it("**応答が申告より短くても、届いた分だけ進む**（飛ばさない）", async () => {
    const content = utf16(1_000);
    // 毎回 2 バイト（1 文字）少なく返るホスト
    const { conn } = charCountingHost(content, 1200, { segmentUnits: 10, shortBy: 2 });
    const got = await retrieveLob(conn, 1, { maxBytes: 64 * 1024 });
    // 全部は取れないかもしれないが、**取れた分は先頭から連続**していること
    expect([...got.bytes]).toEqual([...content.subarray(0, got.bytes.length)]);
  });

  it("**本体が空でも総長はバイトで返す**（CCSID を読んでから抜ける）", async () => {
    // 総長は申告するのに本体を返さないホスト。**CCSID を読む前に抜けると**
    // 単位が分からず、2 バイト CCSID の総長が半分（文字数のまま）で返る
    const conn = {
      async request() {
        const data = new Uint8Array(6);
        new DataView(data.buffer).setUint16(0, 1200);
        const len = new Uint8Array(6);
        const lv = new DataView(len.buffer);
        lv.setUint16(0, 4);
        lv.setUint32(2, 1_000); // 1,000 文字 = 2,000 バイト
        return {
          dbTemplate: { rcClass: 0, rcClassReturnCode: 0 },
          params: [
            { cp: CP.dataLength, value: len },
            { cp: CP.data, value: data }
          ]
        };
      }
    } as unknown as DbConnection;
    const got = await retrieveLob(conn, 1, { maxBytes: 64 * 1024 });
    expect(got.totalLength).toBe(2_000);
    expect(got.bytes.length).toBe(0);
  });

  it("進まなくなったら止まる（無限ループにしない）", async () => {
    const content = utf16(1_000);
    // 常に空を返すホスト
    const conn = {
      async request() {
        const data = new Uint8Array(6);
        new DataView(data.buffer).setUint16(0, 1200);
        const len = new Uint8Array(6);
        const lv = new DataView(len.buffer);
        lv.setUint16(0, 4);
        lv.setUint32(2, 1_000);
        return {
          dbTemplate: { rcClass: 0, rcClassReturnCode: 0 },
          params: [
            { cp: CP.dataLength, value: len },
            { cp: CP.data, value: data }
          ]
        };
      }
    } as unknown as DbConnection;
    const got = await retrieveLob(conn, 1, { maxBytes: 64 * 1024 });
    expect(got.bytes.length).toBe(0);
    void content;
  });

  it("上限 0 なら 1 度も要求しない", async () => {
    const content = utf16(1_000);
    const { conn, asks } = charCountingHost(content, 1200);
    const got = await retrieveLob(conn, 1, { maxBytes: 0 });
    expect(asks.length).toBe(0);
    expect(got.bytes.length).toBe(0);
  });
});
