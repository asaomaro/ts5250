import { describe, it, expect } from "vitest";
import {
  buildFilter,
  parseSpoolRecord,
  buildSortInfo,
  listSpooledFiles
} from "../src/spool/spool-list.js";
import type { CommandConnection } from "../src/command/command-connection.js";
import { statusName, cyymmddToIso, hhmmssToReadable } from "../src/spool/spool-types.js";
import { As400Error } from "@ts5250/base";
import { codecForCcsid } from "@ts5250/ebcdic/codec";

/**
 * フィルタの配置は実機で確かめたもの。**オフセット表ではなく、件数と配列が交互**。
 * 各配列は最低 1 件必要（0 件だと GUI0011 / GUI0012 で弾かれる）。
 */
describe("buildFilter", () => {
  const f = buildFilter();

  it("件数と配列が交互に並ぶ（オフセット表ではない）", () => {
    const v = new DataView(f.buffer);
    expect(v.getInt32(0)).toBe(1); // ユーザー件数
    // 名前(10) + 予約(2) の後に OUTQ 件数
    expect(v.getInt32(4 + 12)).toBe(1);
  });

  it("既定のユーザーは *CURRENT", () => {
    // *CURRENT = 5C C3 E4 D9 D9 C5 D5 E3
    expect([...f.subarray(4, 6)]).toEqual([0x5c, 0xc3]);
  });

  it("絞り込まない項目には *ALL を入れる（0 件は弾かれるため）", () => {
    const v = new DataView(f.buffer);
    // 状態と装置も 1 件ずつ入っている
    expect(v.getInt32(4 + 12 + 4 + 20 + 10 + 10)).toBe(1);
  });

  it("ユーザーを指定できる", () => {
    const mine = buildFilter({ user: "USER" });
    expect([...mine.subarray(4, 8)]).toEqual([0xe4, 0xe2, 0xc5, 0xd9]); // USER
  });

  it("CCSID 37 で表せない値を拒否する", () => {
    expect(() => buildFilter({ user: "日本語" })).toThrow(/not representable/);
  });
});

/** 実機の一覧結果に対応するレコードを組み立てて解析する */
function record(): Uint8Array {
  const b = new Uint8Array(136);
  const v = new DataView(b.buffer);
  // 手書きの変換表は誤りの源になるため、実装と同じコーデックを使う
  const put = (text: string, at: number, len: number): void => {
    const filled = text.padEnd(len, " ").slice(0, len);
    b.set(codecForCcsid(37).encode(filled).bytes.subarray(0, len), at);
  };
  put("QPRTJOB   ", 0, 10);
  put("USER      ", 10, 10);
  put("681803", 20, 6);
  put("QPRTLIBL  ", 26, 10);
  v.setInt32(36, 5); // ファイル番号
  v.setInt32(40, 1); // 状態 READY
  put("1260718", 44, 7); // CYYMMDD → 2026-07-18
  put("165005", 51, 6);
  put("PUB400    ", 58, 10);
  put("          ", 68, 10);
  put("STD       ", 78, 10);
  put("QEZJOBLOG ", 88, 10);
  put("QUSRSYS   ", 98, 10);
  v.setInt32(112, 512); // size
  v.setInt32(116, 1); // multiplier
  v.setInt32(120, 7); // 総ページ
  v.setInt32(124, 1); // 残部数
  put("5", 128, 1);
  return b;
}

describe("parseSpoolRecord", () => {
  const e = parseSpoolRecord(record());

  it("識別子を取り出す（そのまま中身取得へ渡せる）", () => {
    expect(e.jobName).toBe("QPRTJOB");
    expect(e.jobUser).toBe("USER");
    expect(e.jobNumber).toBe("681803");
    expect(e.fileName).toBe("QPRTLIBL");
    expect(e.fileNumber).toBe(5);
  });

  it("状態をコードと名前の両方で返す", () => {
    expect(e.statusCode).toBe(1);
    expect(e.status).toBe("READY");
  });

  it("日時を読める形式にする", () => {
    expect(e.dateOpened).toBe("2026-07-18");
    expect(e.timeOpened).toBe("16.50.05");
  });

  it("出力待ち行列とページ数", () => {
    expect(e.outputQueue).toBe("QEZJOBLOG");
    expect(e.outputQueueLibrary).toBe("QUSRSYS");
    expect(e.totalPages).toBe(7);
  });

  it("大きさは size × multiplier", () => {
    expect(e.size).toBe(512);
  });

  it("短すぎるレコードを拒否する", () => {
    expect(() => parseSpoolRecord(new Uint8Array(50))).toThrow(As400Error);
  });
});

/**
 * リスト情報（80 バイト）を組み立てる。
 * 位置は実装の LIST_INFO と対（total:0 / returned:4 / handle:8 / recordLength:12）。
 */
function listInfo(total: number, returned: number, recordLength = 136): Uint8Array {
  const b = new Uint8Array(80);
  const v = new DataView(b.buffer);
  v.setInt32(0, total);
  v.setInt32(4, returned);
  v.setInt32(12, recordLength);
  return b;
}

/** QGYOLSPL の応答だけを差し替えた最小のコマンド接続 */
function fakeConn(records: Uint8Array, info: Uint8Array): CommandConnection {
  return {
    call: async () => ({
      result: { success: true, messages: [] },
      // outputs[0]=レコード列 / outputs[2]=リスト情報（実装のパラメータ順と対）
      outputs: [records, undefined, info]
    })
  } as unknown as CommandConnection;
}

/**
 * `returned` の件数ぶんだけレコードを解析する、という契約を固める。
 *
 * **`total`（offset 0）は読まない。** 名前に反して一致総数ではなく、返した件数と同値だと
 * 実機で判明しているため（LIST_INFO のコメント参照）。打ち切り判定は呼び出し側が
 * `max + 1` 件要求して行う。ここで人工的に `total ≠ returned` の応答を作ってしまうと、
 * **実機では起こらない状態を前提にしたテストが緑になる**——実際それで前提の誤りを見逃した。
 */
describe("listSpooledFiles", () => {
  it("returned の件数ぶんを解析して返す", async () => {
    const res = await listSpooledFiles(fakeConn(record(), listInfo(1, 1)), {}, { max: 100 });

    expect(res).toHaveLength(1);
    expect(res[0]?.fileName).toBe("QPRTLIBL");
  });

  it("レコード長 0 なら空（解析全体を落とさない）", async () => {
    expect(await listSpooledFiles(fakeConn(new Uint8Array(0), listInfo(0, 0, 0)))).toEqual([]);
  });

  it("バッファが足りなければ入っている分で打ち切る（例外にしない）", async () => {
    // returned は 2 と言っているが、レコードは 1 件分しか入っていない
    const res = await listSpooledFiles(fakeConn(record(), listInfo(2, 2)));

    expect(res).toHaveLength(1);
  });
});

describe("statusName", () => {
  it("主要な状態", () => {
    expect(statusName(1)).toBe("READY");
    expect(statusName(6)).toBe("HELD");
    expect(statusName(7)).toBe("MESSAGE_WAIT");
  });

  it("未知のコードも情報を落とさない", () => {
    expect(statusName(99)).toBe("UNKNOWN(99)");
  });
});

describe("cyymmddToIso（世紀 1 桁 ＋ 年月日）", () => {
  it("1 は 2000 年代", () => {
    expect(cyymmddToIso("1260718")).toBe("2026-07-18");
  });

  it("0 は 1900 年代", () => {
    expect(cyymmddToIso("0991231")).toBe("1999-12-31");
  });

  it("形式が違えば空文字（解析全体を落とさない）", () => {
    expect(cyymmddToIso("")).toBe("");
    expect(cyymmddToIso("abc")).toBe("");
  });
});

describe("hhmmssToReadable", () => {
  it("区切りを入れる", () => {
    expect(hhmmssToReadable("165005")).toBe("16.50.05");
  });
  it("形式が違えば空文字", () => {
    expect(hhmmssToReadable("12")).toBe("");
  });
});

/**
 * **一覧は新しい順に並べる。**
 *
 * 指定しないとホストは古い順に返す。一覧は件数で打ち切られるので、実際に使う新しい
 * スプールが窓の外に出て見えない（実機で確認: 先頭が 2021-11-01 で、1000 件目でもまだ
 * 2021-12-07。当日のスプールは載らず、ユーザーデータを持つものが 1000 件中 2 件しか
 * 現れなかった）。
 *
 * 書式は実機で総当たりして決めた。**1 キー 12 バイト・予約は 0x00**。
 * 14 バイトだとキーが 1 つのときだけ通り、2 つ目からズレて GUI0119 で落ちる。
 * 予約をブランク(0x40)で埋めても同じく GUI0119。
 */
describe("buildSortInfo", () => {
  it("キー数のあとに 12 バイトずつ並ぶ", () => {
    const b = buildSortInfo([{ start: 45, length: 7 }]);
    expect(b).toHaveLength(4 + 12);
    const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
    expect(v.getInt32(0), "キー数").toBe(1);
    expect(v.getInt32(4), "開始位置（1 始まり）").toBe(45);
    expect(v.getInt32(8), "長さ").toBe(7);
    expect(v.getInt16(12), "型＝文字").toBe(4);
    expect(b[14], "降順（EBCDIC の 2）").toBe(0xf2);
    expect(b[15], "予約は 0x00（ブランクだと GUI0119）").toBe(0x00);
  });

  it("2 キーでも 12 バイト刻みで続く", () => {
    const b = buildSortInfo([
      { start: 45, length: 7 },
      { start: 52, length: 6 }
    ]);
    expect(b).toHaveLength(4 + 24);
    const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
    expect(v.getInt32(0)).toBe(2);
    expect(v.getInt32(16), "2 キー目の開始位置").toBe(52);
    expect(v.getInt32(20), "2 キー目の長さ").toBe(6);
  });
});
