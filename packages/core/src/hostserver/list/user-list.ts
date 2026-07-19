/**
 * ユーザープロファイル一覧（`QSYRAUTU`）。
 *
 * オープンリスト API ではなく「認可ユーザーの取得」。
 * 受信変数とリスト情報の骨格は同じなので `callOpenList` を使い回す。
 *
 * 参照: JTOpen(jtopenlite) の RetrieveAuthorizedUsers に対応する。
 */
import type { CommandConnection } from "../command/command-connection.js";
import { callOpenList, padEbcdic, readEbcdic, int32 } from "./openlist.js";

export interface UserEntry {
  name: string;
  /** グループプロファイルか */
  isGroup: boolean;
  /** 所属グループ（無ければ空） */
  groupProfile: string;
  text: string;
}

export interface UserListFilter {
  /** 例 "*USER"（ユーザーのみ）/ "*GROUP" / "*MEMBER" */
  selection?: "*USER" | "*GROUP" | "*MEMBER";
  /** ここから始める（空なら先頭から） */
  startingUser?: string;
}

/**
 * AUTU0150 のレコード配置。
 *
 * 名前(10) ＋ ユーザー/グループ指標(1) ＋ **グループメンバー指標(1)** ＋ テキスト(50)。
 * 2 つ目の指標を飛ばすとテキストが 1 文字ずれる。
 */
const F = {
  name: 0,
  groupIndicator: 10,
  groupMembersIndicator: 11,
  text: 12,
  groupProfile: 62
} as const;

/** ユーザープロファイルを一覧する */
export async function listUsers(
  conn: CommandConnection,
  filter: UserListFilter = {},
  opts: { max?: number } = {}
): Promise<UserEntry[]> {
  const max = opts.max ?? 200;
  // 1 レコード 62 バイト。max 件が確実に入る大きさにする
  const receiveLength = Math.max(8192, max * 128);

  return callOpenList(
    conn,
    "QSYRAUTU",
    "QSYS",
    [
      { type: "out", length: receiveLength },
      { type: "in", data: int32(receiveLength) },
      { type: "out", length: 80 },
      { type: "in", data: padEbcdic("AUTU0150", 8) },
      { type: "in", data: padEbcdic(filter.selection ?? "*USER", 10) },
      { type: "in", data: padEbcdic(filter.startingUser ?? "*FIRST", 10) },
      // 開始ユーザーを含めるか（0xF1 = 含める / 0xF2 = 含めない）
      { type: "in", data: Uint8Array.from([0xf1]) },
      // 選択条件が *MEMBER 以外のときは *NONE でなければならない
      // （*ALL を渡すと CPF22ED "Group profile name must be *NONE ..."）
      { type: "in", data: padEbcdic("*NONE", 10) },
      { type: "inout", data: int32(0), length: 4 }
    ],
    {
      receiveIndex: 0,
      listInfoIndex: 2,
      decode: (r) => ({
        name: readEbcdic(r, F.name, 10),
        // 0xF1 = グループ
        isGroup: r[F.groupIndicator] === 0xf1,
        text: readEbcdic(r, F.text, 50),
        groupProfile: readEbcdic(r, F.groupProfile, 10)
      })
    }
  );
}
