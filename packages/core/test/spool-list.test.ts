import { describe, it, expect } from "vitest";
import { buildFilter, parseSpoolRecord } from "../src/hostserver/spool/spool-list.js";
import { statusName, cyymmddToIso, hhmmssToReadable } from "../src/hostserver/spool/spool-types.js";
import { Tn5250Error } from "../src/errors.js";
import { codecForCcsid } from "../src/codec/codec.js";

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
    expect(() => parseSpoolRecord(new Uint8Array(50))).toThrow(Tn5250Error);
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
