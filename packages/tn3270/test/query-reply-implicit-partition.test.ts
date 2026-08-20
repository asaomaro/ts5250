import { describe, it, expect } from "vitest";
import {
  buildQueryReply,
  splitStructuredFields,
  QR,
  SF_TYPE
} from "../src/protocol/query-reply.js";
import { alternateSizeFor, PRIMARY_SIZE, type Model3270 } from "../src/telnet/terminal-type.js";

/**
 * ImplicitPartition の自己定義パラメータは**幅・高さを 4 つとも 2 バイトで書く**。
 *
 * 標準サイズだけ 1 バイトで書いていた間、後続が 1 桁ずつずれて
 * **ホストは代替幅を 24 桁と読んでいた**。TK4-（MVS 3.8j）の TSO はそれを信じ、
 * 行モードの出力を 24 桁で折って `IKJ56714A ENTER CURRENT` ＋ `***` に切った。
 * 画面サイズそのものは 24x80 のままなので、**画面を見ても分からない**類の壊れ方だった。
 */
const implicitPartition = (model: Model3270): Uint8Array => {
  const reply = buildQueryReply({ model });
  const sf = splitStructuredFields(reply).find(
    (x) => x.type === SF_TYPE.QUERY_REPLY && x.body[0] === QR.IMPLICIT_PARTITION
  );
  if (sf === undefined) throw new Error("ImplicitPartition が申告されていない");
  return sf.body;
};

describe("Query Reply の ImplicitPartition", () => {
  for (const model of [2, 5] as const) {
    it(`モデル ${model}: 標準・代替の 4 値が 2 バイトずつ並ぶ`, () => {
      const body = implicitPartition(model);
      const alt = alternateSizeFor(model);
      // body = [QCODE, FLAGS(2), LL, SDPID, FLAGS, WD(2), HD(2), WA(2), HA(2)]
      expect(Array.from(body.subarray(3, 6))).toEqual([0x0b, 0x01, 0x00]);
      expect(Array.from(body.subarray(6))).toEqual([
        (PRIMARY_SIZE.cols >> 8) & 0xff, PRIMARY_SIZE.cols & 0xff,
        (PRIMARY_SIZE.rows >> 8) & 0xff, PRIMARY_SIZE.rows & 0xff,
        (alt.cols >> 8) & 0xff, alt.cols & 0xff,
        (alt.rows >> 8) & 0xff, alt.rows & 0xff
      ]);
    });

    it(`モデル ${model}: 宣言した長さ 0x0b と実体の長さが合う`, () => {
      const body = implicitPartition(model);
      // LL は自身から末尾まで（LL + SDPID + FLAGS + 2 バイト × 4）
      expect(body[3]).toBe(body.length - 3);
    });
  }
});
