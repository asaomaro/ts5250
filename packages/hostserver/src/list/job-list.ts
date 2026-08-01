/**
 * ジョブ一覧（`QGYOLJOB`）。
 *
 * **出力パラメータの位置が要点**——受信変数(0)・レコード形式情報(3)・リスト情報(5)・
 * エラーコード(12)・経過時間(15) が出力。リスト情報を 3 から読むと
 * **エラーが出ないまま常に 0 件**になる（実際にこれで一度見送りかけた）。
 *
 * 参照: JTOpen(jtopenlite) の OpenListOfJobs /
 *       OpenListOfJobsFormatOLJB0100 に対応する。
 */
import type { CommandConnection } from "../command/command-connection.js";
import { callOpenList, padEbcdic, readEbcdic, int32 } from "./openlist.js";

export interface JobEntry {
  name: string;
  user: string;
  number: string;
  /** 例 "*ACTIVE" / "*JOBQ" / "*OUTQ" */
  status: string;
  /** 例 "S"（システム）/ "B"（バッチ）/ "I"（対話）/ "X"（開始） */
  type: string;
  subtype: string;
}

export interface JobListFilter {
  /** 既定 "*ALL"。自分のジョブだけなら "*CURRENT" */
  name?: string;
  user?: string;
  number?: string;
  /** 例 "*"（すべて）/ "B"（バッチ）/ "I"（対話） */
  type?: string;
}

/** OLJB0100 のレコード配置 */
const F = {
  name: 0,
  user: 10,
  number: 20,
  /** 内部ジョブ識別子 16 バイト（本実装では返さない） */
  status: 42,
  type: 52,
  subtype: 53
} as const;

/** ジョブ選択情報（OLJS0100）。全体で 60 バイト */
const JOB_SELECTION_LEN = 60;

function jobSelection(filter: JobListFilter): Uint8Array {
  const out = new Uint8Array(JOB_SELECTION_LEN);
  out.set(padEbcdic(filter.name ?? "*ALL", 10), 0);
  out.set(padEbcdic(filter.user ?? "*ALL", 10), 10);
  out.set(padEbcdic(filter.number ?? "*ALL", 6), 20);
  out.set(padEbcdic(filter.type ?? "*", 1), 26);
  // 27 以降は予約と「変位/件数」の対。すべて 0 のままで絞り込まない
  return out;
}

/**
 * ジョブを一覧する。
 *
 * 権限の範囲でしか見えない——一般ユーザーではシステムジョブと自分のジョブが中心。
 */
export async function listJobs(
  conn: CommandConnection,
  filter: JobListFilter = {},
  opts: { max?: number } = {}
): Promise<JobEntry[]> {
  const max = opts.max ?? 100;
  // 1 レコード 56 バイト。余裕を持たせる
  const receiveLength = Math.max(8192, max * 128);
  const selection = jobSelection(filter);

  return callOpenList(
    conn,
    "QGYOLJOB",
    "QGY",
    [
      { type: "out", length: receiveLength },
      { type: "in", data: int32(receiveLength) },
      { type: "in", data: padEbcdic("OLJB0100", 8) },
      // レコード形式情報。返す欄が 0 個なので 4 バイト
      { type: "out", length: 4 },
      { type: "in", data: int32(4) },
      // ★ リスト情報はここ（index 5）。3 から読むと常に 0 件になる
      { type: "out", length: 80 },
      { type: "in", data: int32(max) },
      { type: "in", data: int32(0) }, // ソートなし
      { type: "in", data: selection },
      { type: "in", data: int32(JOB_SELECTION_LEN) },
      { type: "in", data: int32(0) }, // 返す欄の数
      { type: "in", data: new Uint8Array(0) }, // 欄のキー
      { type: "inout", data: int32(0), length: 4 },
      { type: "in", data: padEbcdic("OLJS0100", 8) },
      { type: "in", data: Uint8Array.from([0xf0]) }, // 統計をリセットしない
      { type: "out", length: 16 }, // 経過時間
      { type: "in", data: int32(16) }
    ],
    {
      receiveIndex: 0,
      listInfoIndex: 5,
      decode: (r, c) => ({
        name: readEbcdic(r, F.name, 10, c),
        user: readEbcdic(r, F.user, 10, c),
        number: readEbcdic(r, F.number, 6, c),
        status: readEbcdic(r, F.status, 10, c),
        type: readEbcdic(r, F.type, 1, c),
        subtype: readEbcdic(r, F.subtype, 1, c)
      })
    }
  );
}
