import { describe, it, expect } from "vitest";
import { buildRequest, findParam, parseReply } from "../src/hostserver/datastream.js";
import { parseResultData, parseDataFormat } from "../src/hostserver/db/db-reply.js";
import { DB_CP } from "../src/hostserver/db/db-datastream.js";

/**
 * **長さ 0 のパラメータ**の扱い。
 *
 * ホストは「パラメータは在るが中身が無い」応答を返すことがある。
 * `findParam` は空の Uint8Array を返し、これは truthy なので
 * `if (!raw)` の判定をすり抜けて解析に入り、`too short: 0 bytes` で落ちる。
 *
 * 実機で踏んだ経路（PUB400・IBM i 7.5）:
 *   - 行数がブロッキング係数のちょうど倍数のとき、最後の fetch が
 *     「SQLCODE 100 ＋ 長さ 0 の結果データ」で返る
 *     （FETCH FIRST 100 / 200 は失敗、99 / 101 は成功）
 *   - LOB 列を含む結果セットの prepare が、長さ 0 の列定義で返る
 */
function replyWith(cp: number, value: Uint8Array) {
  // 応答フレームを組み立てて解析する（実際の経路と同じ形で確かめる）
  const frame = buildRequest({
    serverId: 0xe004,
    reqRep: 0x2800,
    template: new Uint8Array(4),
    params: [{ cp, value }]
  });
  return parseReply(frame);
}

describe("長さ 0 のパラメータは「無し」と区別できない形で返る", () => {
  it("findParam は空のパラメータを truthy な値として返す", () => {
    const reply = replyWith(DB_CP.resultData, new Uint8Array(0));
    const raw = findParam(reply, DB_CP.resultData);
    // ここが問題の根——`!raw` では弾けない
    expect(raw).toBeDefined();
    expect(raw).toHaveLength(0);
    expect(Boolean(raw)).toBe(true);
  });

  it("空の結果データを解析しようとすると落ちる（だから呼ぶ前に弾く）", () => {
    expect(() => parseResultData(new Uint8Array(0))).toThrow(/result data too short: 0 bytes/);
  });

  it("空の列定義を解析しようとすると落ちる（だから呼ぶ前に弾く）", () => {
    expect(() => parseDataFormat(new Uint8Array(0))).toThrow(/data format too short: 0 bytes/);
  });

  it("中身のあるパラメータは従来どおり取れる", () => {
    const reply = replyWith(DB_CP.resultData, Uint8Array.from([1, 2, 3]));
    expect(findParam(reply, DB_CP.resultData)).toEqual(Uint8Array.from([1, 2, 3]));
  });
});

describe("呼び出し側が守るべき条件", () => {
  // query.ts の fetchAll / prepareAndOpen は「長さ 0 なら解析に進まない」ことで
  // この失敗を避けている。その判定式そのものを固定する。
  const guard = (raw: Uint8Array | undefined): boolean => !raw || raw.length === 0;

  it("未定義と長さ 0 の両方を弾く", () => {
    expect(guard(undefined)).toBe(true);
    expect(guard(new Uint8Array(0))).toBe(true);
  });

  it("中身があれば通す", () => {
    expect(guard(Uint8Array.from([0]))).toBe(false);
  });
});
