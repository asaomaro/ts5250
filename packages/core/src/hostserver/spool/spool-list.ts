/**
 * スプールファイルの一覧（`QGYOLSPL` をコマンドサーバー経由で呼ぶ）。
 *
 * 参照: JTOpen(jtopenlite) の OpenListOfSpooledFiles /
 *       OpenListOfSpooledFilesFormatOSPL0300 に対応する。
 *
 * **実機で確かめた注意点**（推測で組むと通らない）:
 *   - フィルタ OSPF0100 は**オフセット表ではなく、件数と配列が交互に並ぶ連続配置**
 *   - 各配列は**最低 1 件必要**（0 件だと GUI0011 / GUI0012 で弾かれる）
 *   - 修飾ジョブ名は**空白**（`*ALL` は CPF3342 で弾かれる）
 */
import { As400Error } from "../../errors.js";
import { codecForCcsid } from "../../codec/codec.js";
import { codecOf } from "../list/openlist.js";
import type { CommandConnection } from "../command/command-connection.js";
import {
  statusName,
  cyymmddToIso,
  hhmmssToReadable,
  type SpoolEntry,
  type SpoolListFilter
} from "./spool-types.js";

const EBCDIC_CCSID = 37;
const EBCDIC_SPACE = 0x40;
/** 絞り込まない場合に入れる値 */
const ALL = "*ALL";
/** 既定のユーザー（接続ユーザー） */
const CURRENT_USER = "*CURRENT";
/**
 * リスト情報（80 バイト）の項目位置。
 *
 * **`total` は「条件に一致した総件数」ではなく「構築されたリストの件数」**＝
 * `min(max, 実際の一致件数)` である。`max` がリストの構築量そのものを決めるため。
 *
 * 実機 PUB400（スプール 3 件）で `max` を振って計測した:
 *
 * ```
 *   max=0   total=0  returned=0  完了指示子=I(incomplete)
 *   max=1   total=1  returned=1  完了指示子=C(complete)
 *   max=2   total=2  returned=2  完了指示子=C(complete)
 *   max=5   total=3  returned=3  完了指示子=C(complete)
 * ```
 *
 * `max=1` でも完了指示子（オフセット 16）は `C` を返す——API は「1 件のリストを作り終えた」
 * と言っているのであって、総数が未確定なのではない。`max=0` で総数だけ取る idiom も効かない。
 *
 * **よって打ち切り判定にこの値は使えない**（`max` で頭打ちになるため常に
 * `total == returned` になり、truncated が常に false ＝「全件見た」と誤解させる偽陰性）。
 * 打ち切りは `max + 1` 件要求して判定する——`min(max+1, 実件数) > max ⟺ 実件数 > max` で、
 * この API で打ち切りを知る唯一の形（server の `listSpools`）。
 * 真の総数を知るにはリストを全件構築するしかない。
 */
const LIST_INFO = { total: 0, returned: 4, handle: 8, recordLength: 12 } as const;

const codec = codecForCcsid(EBCDIC_CCSID);

function pad(text: string, length: number): Uint8Array {
  const out = new Uint8Array(length).fill(EBCDIC_SPACE);
  const { bytes, substituted } = codec.encode(text.toUpperCase());
  if (substituted > 0) {
    throw new As400Error(
      "CONFIG_ERROR",
      `"${text}" contains characters not representable in CCSID ${EBCDIC_CCSID}`
    );
  }
  out.set(bytes.subarray(0, length));
  return out;
}

function int32(value: number): Uint8Array {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setInt32(0, value);
  return b;
}

function concat(parts: readonly Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let pos = 0;
  for (const p of parts) {
    out.set(p, pos);
    pos += p.length;
  }
  return out;
}

/**
 * OSPF0100 フィルタを組み立てる。
 *
 * 配置は**件数と配列が交互**。オフセット表ではない（原典を読んで確定した）。
 */
export function buildFilter(filter: SpoolListFilter = {}): Uint8Array {
  return concat([
    // ユーザー: 件数 + [名前(10) + 予約(2)]
    int32(1),
    pad(filter.user ?? CURRENT_USER, 10),
    new Uint8Array(2),
    // 出力待ち行列: 件数 + [名前(10) + ライブラリ(10)]
    int32(1),
    pad(filter.outputQueue ?? ALL, 10),
    // OUTQ を指定しないときはライブラリも空にする（*ALL にライブラリは要らない）
    pad(filter.outputQueue ? (filter.outputQueueLibrary ?? "*LIBL") : "", 10),
    // 用紙タイプ・ユーザーデータ
    pad(filter.formType ?? ALL, 10),
    pad(filter.userData ?? ALL, 10),
    // 状態: 件数 + [状態(10) + 予約(2)]
    int32(1),
    pad(filter.status ?? ALL, 10),
    new Uint8Array(2),
    // プリンター装置: 件数 + [装置(10) + 予約(2)]
    int32(1),
    pad(ALL, 10),
    new Uint8Array(2)
  ]);
}

/**
 * ソート情報（QGY 共通の書式）。
 *
 * **既定で新しい順に並べる。** 指定しないとホストは**古い順**に返し、しかも一覧は件数で
 * 打ち切られるので、実際に使う新しいスプールが窓の外に出て見えない
 * （実機で確認: 先頭が 2021-11-01、1000 件目でまだ 2021-12-07。当日のスプールは載らない）。
 *
 * 書式は「キー数(4) + [開始位置(4) 長さ(4) 型(2) 昇降(1) 予約(1)]×キー数」＝ **1 キー 12 バイト**。
 * 開始位置は**レコード内の 1 始まり**。作成日（CYYMMDD）は文字の降順がそのまま新しい順になる。
 *
 * 大きさと予約の埋め方は実機で総当たりして決めた。14 バイトだとキーが 1 つのときだけ通り
 * （余りを読まないため）、2 つ目からズレて GUI0119 で落ちる。予約をブランク(0x40)で
 * 埋めても同じく GUI0119。**12 バイト・予約は 0x00** が正解。
 */
export function buildSortInfo(keys: readonly { start: number; length: number }[]): Uint8Array {
  const parts: Uint8Array[] = [int32(keys.length)];
  for (const k of keys) {
    const b = new Uint8Array(12);
    const v = new DataView(b.buffer);
    v.setInt32(0, k.start);
    v.setInt32(4, k.length);
    v.setInt16(8, SORT_TYPE_CHAR);
    b[10] = SORT_DESCENDING;
    parts.push(b);
  }
  return concat(parts);
}

/** キー種別: 文字データ（NLS 照合はしない）。日付・時刻は CYYMMDD / HHMMSS の文字 */
const SORT_TYPE_CHAR = 4;
/** 降順。EBCDIC の '2' */
const SORT_DESCENDING = 0xf2;

/** レコード（OSPL0300）内の項目位置。原典 OpenListOfSpooledFilesFormatOSPL0300 に対応 */
const F = {
  jobName: 0,
  jobUser: 10,
  jobNumber: 20,
  fileName: 26,
  fileNumber: 36,
  statusCode: 40,
  dateOpened: 44,
  timeOpened: 51,
  schedule: 57,
  jobSystemName: 58,
  userData: 68,
  formType: 78,
  outputQueue: 88,
  outputQueueLibrary: 98,
  asp: 108,
  size: 112,
  multiplier: 116,
  totalPages: 120,
  copiesLeft: 124,
  priority: 128
} as const;

/**
 * 1 レコードを解釈する。
 * `textCodec` はホストサーバージョブの CCSID のコーデック（省略時は CCSID 37）。
 * 用紙タイプやユーザーデータに日本語が入ることがあり、37 固定だとバイトごとに化ける。
 */
export function parseSpoolRecord(record: Uint8Array, textCodec = codec): SpoolEntry {
  if (record.length < F.priority + 1) {
    throw new As400Error(
      "PROTOCOL_ERROR",
      `spool record too short: ${record.length} bytes (need >= ${F.priority + 1})`
    );
  }
  const v = new DataView(record.buffer, record.byteOffset, record.byteLength);
  const str = (at: number, len: number): string =>
    textCodec.decode(record.subarray(at, at + len)).trimEnd();
  const statusCode = v.getInt32(F.statusCode);

  return {
    jobName: str(F.jobName, 10),
    jobUser: str(F.jobUser, 10),
    jobNumber: str(F.jobNumber, 6),
    fileName: str(F.fileName, 10),
    fileNumber: v.getInt32(F.fileNumber),
    statusCode,
    status: statusName(statusCode),
    dateOpened: cyymmddToIso(str(F.dateOpened, 7)),
    timeOpened: hhmmssToReadable(str(F.timeOpened, 6)),
    jobSystemName: str(F.jobSystemName, 10),
    userData: str(F.userData, 10),
    formType: str(F.formType, 10),
    outputQueue: str(F.outputQueue, 10),
    outputQueueLibrary: str(F.outputQueueLibrary, 10),
    // 大きさは size × multiplier（IBM i がこの 2 つで表現する）
    size: v.getInt32(F.size) * Math.max(1, v.getInt32(F.multiplier)),
    totalPages: v.getInt32(F.totalPages),
    copiesLeft: v.getInt32(F.copiesLeft),
    priority: str(F.priority, 1)
  };
}

export interface ListSpoolOptions {
  /** 取得する最大件数。既定 100 */
  max?: number;
}

/**
 * スプールファイルを一覧する。
 *
 * **権限の範囲でしか見えない**——PUB400 のような一般ユーザーでは自分のスプールのみ。
 * これは制約であって不具合ではない。
 */
export async function listSpooledFiles(
  conn: CommandConnection,
  filter: SpoolListFilter = {},
  opts: ListSpoolOptions = {}
): Promise<SpoolEntry[]> {
  const max = opts.max ?? 100;
  // 1 レコード 136 バイト。余裕を持たせる
  const receiveLength = Math.max(8192, max * 200);

  const { result, outputs } = await conn.call("QGYOLSPL", "QGY", [
    { type: "out", length: receiveLength },
    { type: "in", data: int32(receiveLength) },
    { type: "out", length: 80 },
    { type: "in", data: int32(max) },
    // 作成日→時刻の降順（新しい順）。既定の「古い順」だと打ち切りで最近のものが見えない
    {
      type: "in",
      data: buildSortInfo([
        { start: F.dateOpened + 1, length: 7 },
        { start: F.timeOpened + 1, length: 6 }
      ])
    },
    { type: "in", data: buildFilter(filter) },
    // 修飾ジョブ名は空白。*ALL は CPF3342 で弾かれる
    { type: "in", data: pad("", 26) },
    { type: "in", data: pad("OSPL0300", 8) },
    { type: "inout", data: int32(0), length: 4 },
    { type: "in", data: pad("OSPF0100", 8) }
  ]);

  if (!result.success) {
    const primary = result.messages.find((m) => m.kind === "error" || m.kind === "severe");
    throw new As400Error(
      "COMMAND_FAILED",
      `failed to list spooled files${primary ? `: ${primary.id} ${primary.text}` : ""}`
    );
  }

  const listInfo = outputs[2];
  const records = outputs[0];
  if (!listInfo || !records) {
    throw new As400Error("PROTOCOL_ERROR", "QGYOLSPL returned no list information");
  }
  const li = new DataView(listInfo.buffer, listInfo.byteOffset, listInfo.byteLength);
  const returned = li.getInt32(LIST_INFO.returned);
  const recordLength = li.getInt32(LIST_INFO.recordLength);
  if (recordLength <= 0) return [];

  const textCodec = codecOf(conn);
  const entries: SpoolEntry[] = [];
  for (let i = 0; i < returned; i++) {
    const at = i * recordLength;
    if (at + recordLength > records.length) break;
    entries.push(parseSpoolRecord(records.subarray(at, at + recordLength), textCodec));
  }
  return entries;
}
