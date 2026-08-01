/**
 * オブジェクト一覧（`QGYOLOBJ`）。
 *
 * 参照: JTOpen(jtopenlite) の OpenListOfObjects /
 *       OpenListOfObjectsFormatOBJL0100 に対応する。
 */
import type { CommandConnection } from "../command/command-connection.js";
import { callOpenList, padEbcdic, readEbcdic, int32, concatBytes } from "./openlist.js";

export interface ObjectEntry {
  name: string;
  library: string;
  /** 例 "*PGM" / "*FILE" */
  type: string;
}

export interface ObjectListFilter {
  /** 例 "*ALL" または具体名 */
  name?: string;
  /** 例 "QGPL" / "*LIBL" / "*ALLUSR" */
  library?: string;
  /** 例 "*ALL" / "*PGM" / "*FILE" */
  type?: string;
}

/** OBJL0100 のレコード配置（名前 10 ＋ ライブラリ 10 ＋ 種別 10） */
const F = { name: 0, library: 10, type: 20 } as const;

/**
 * 権限制御パラメータ。
 * 絞り込まない場合は**長さ 28 を書いて残りを 0** にする（原典どおり）。
 */
function authorityControl(): Uint8Array {
  const b = new Uint8Array(28);
  new DataView(b.buffer).setInt32(0, 28);
  return b;
}

/**
 * 選択制御パラメータ。
 *
 * 全 21 バイト。末尾の 1 バイトに状態 `*`（すべて）を EBCDIC で置く。
 * 長さを 20 にすると `CPF21AC "Length or displacement value 20 not valid."` で弾かれる。
 */
function selectionControl(): Uint8Array {
  const b = new Uint8Array(21);
  const v = new DataView(b.buffer);
  v.setInt32(0, 21); // 全体長
  v.setInt32(4, 0); // 0 = 選択（1 = 除外）
  v.setInt32(8, 20); // 状態への変位
  v.setInt32(12, 1); // 状態の数
  v.setInt32(16, 0); // 予約
  b.set(padEbcdic("*", 1), 20); // すべての状態
  return b;
}

/** オブジェクトを一覧する */
export async function listObjects(
  conn: CommandConnection,
  filter: ObjectListFilter = {},
  opts: { max?: number } = {}
): Promise<ObjectEntry[]> {
  const max = opts.max ?? 200;
  const receiveLength = Math.max(8192, max * 64);

  return callOpenList(
    conn,
    "QGYOLOBJ",
    "QSYS",
    [
      { type: "out", length: receiveLength },
      { type: "in", data: int32(receiveLength) },
      { type: "out", length: 80 },
      { type: "in", data: int32(max) },
      { type: "in", data: int32(0) }, // ソートなし（長さ 4 の 0）
      {
        type: "in",
        data: concatBytes([
          padEbcdic(filter.name ?? "*ALL", 10),
          padEbcdic(filter.library ?? "*LIBL", 10)
        ])
      },
      { type: "in", data: padEbcdic(filter.type ?? "*ALL", 10) },
      { type: "in", data: authorityControl() },
      { type: "in", data: selectionControl() },
      // 追加属性は要求しない。数を 0 にし、キー配列は空で送る
      // （数を 1 にして値 0 を送ると CPF1867 "Value 0 in list not valid."）
      { type: "in", data: int32(0) },
      { type: "in", data: new Uint8Array(0) },
      { type: "inout", data: int32(0), length: 4 }
    ],
    {
      receiveIndex: 0,
      listInfoIndex: 2,
      decode: (r, c) => ({
        name: readEbcdic(r, F.name, 10, c),
        library: readEbcdic(r, F.library, 10, c),
        type: readEbcdic(r, F.type, 10, c)
      })
    }
  );
}
