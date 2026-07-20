/**
 * ロケーター経由の LOB 取得。
 *
 * 結果セットに LOB 列が含まれるとき、行データには**値ではなく 4 バイトのロケーター
 * （ハンドル）**が入る。本体を取るにはこの別要求（`0x1816`）が要る。
 *
 * ## ⚠ ロケーターは接続に紐づく
 *
 * 実機で確かめた寿命:
 *
 * | 条件 | 結果 |
 * |---|---|
 * | `query()` がカーソルを閉じた後、**同じ接続** | 取得できる |
 * | **別の接続**で同じ番号 | **失敗（rcClass=2, code=-815）** |
 * | 同じ接続で別のクエリを実行した後 | 取得できる |
 *
 * このプロジェクトの接続は**単発完結**（呼び出しごとに開いて閉じる）なので、
 * 画面に結果を出したあとで「LOB セルをクリックして取得」はできない——
 * その時点で接続は閉じており、ロケーターは無効になっている。
 * **取るなら同じクエリ（同じ接続）の中で取り切ること。**
 *
 * 参照: jtopenlite の `DatabaseConnection.retrieveLOBData` /
 * `sendRetrieveLOBDataRequest` に対応する（事実に基づく書き起こし）。
 */
import { As400Error } from "../../errors.js";
import { childLog } from "../../log.js";
import { findParam } from "../datastream.js";
import { DB_CP, DB_REQ, ORS } from "./db-datastream.js";
import type { DbConnection } from "./db-connection.js";

const log = childLog({ component: "hostserver-lob" });

/** 一度に要求するバイト数。原典が 64KB のバッファで分割受信するのに合わせる */
const SEGMENT_BYTES = 0xffff;
/** 既定の取得上限。**全部取るを既定にしない**（大きな LOB でメモリを掴むため） */
export const DEFAULT_LOB_MAX_BYTES = 64 * 1024;

export interface RetrievedLob {
  bytes: Uint8Array;
  /** ホストが申告した文字コード。**こちらで決め打ちしない** */
  ccsid: number;
  /** LOB 全体のバイト長（取得できた量ではない） */
  totalLength: number;
  /** 上限で打ち切ったか */
  truncated: boolean;
}

/**
 * ロケーターから LOB の本体を取る。
 *
 * 1 応答に収まらないことがあるので、**開始オフセットを進めて繰り返す**。
 * 進まなくなったら打ち切る（無限ループにしない）。
 */
export async function retrieveLob(
  conn: DbConnection,
  locator: number,
  opts: { maxBytes?: number; startOffset?: number } = {}
): Promise<RetrievedLob> {
  const maxBytes = opts.maxBytes ?? DEFAULT_LOB_MAX_BYTES;
  let offset = opts.startOffset ?? 0;
  const chunks: Uint8Array[] = [];
  let received = 0;
  let ccsid = 0;
  let totalLength = 0;

  for (;;) {
    const want = Math.min(SEGMENT_BYTES, maxBytes - received);
    if (want <= 0) break;

    const reply = await conn.request({
      reqId: DB_REQ.retrieveLobData,
      orsBitmap: ORS.sendReplyImmediately | ORS.dataFormat | ORS.resultData,
      params: [
        uint32(DB_CP.lobLocatorHandle, locator),
        uint32(DB_CP.lobRequestedSize, want),
        uint32(DB_CP.lobStartOffset, offset),
        byte(DB_CP.lobTranslateIndicator, 0xf1),
        byte(DB_CP.lobReturnCurrentLength, 0xf1)
      ],
      allowTemplateError: true
    });

    const t = reply.dbTemplate;
    if (t.rcClass !== 0) {
      throw new As400Error(
        "PROTOCOL_ERROR",
        `LOB の取得に失敗しました（locator=${locator}, rcClass=${t.rcClass}, code=${t.rcClassReturnCode}）。` +
          // -815 は「そのロケーターは無い」。接続をまたいだときに必ず起きる
          (t.rcClassReturnCode === -815
            ? "ロケーターは接続に紐づきます。取得は同じ接続の中で行ってください"
            : "")
      );
    }

    const rawLength = findParam(reply, DB_CP.lobDataLength);
    if (rawLength && rawLength.length >= 2 && totalLength === 0) {
      totalLength = parseLobLength(rawLength);
    }

    const rawData = findParam(reply, DB_CP.lobData);
    if (!rawData || rawData.length <= 6) break;

    const view = new DataView(rawData.buffer, rawData.byteOffset, rawData.byteLength);
    ccsid = view.getUint16(0);
    const dataLength = view.getUint32(2);
    const body = rawData.subarray(6, Math.min(6 + dataLength, rawData.length));
    if (body.length === 0) break;

    chunks.push(body);
    received += body.length;
    offset += body.length;

    if (totalLength > 0 && offset >= totalLength) break;
    // **進まなくなったら打ち切る**（無限ループ防止）
    if (body.length < want) break;
  }

  const bytes = concat(chunks, received);
  const truncated = totalLength > 0 && bytes.length < totalLength;
  log.debug(`retrieved LOB ${locator}: ${bytes.length}/${totalLength} bytes ccsid=${ccsid}`);
  return { bytes, ccsid, totalLength: totalLength || bytes.length, truncated };
}

/**
 * LOB データ長（CP `0x3810`）を読む。
 * 先頭 2 バイトが長さの幅——0 なら長さなし、4 なら 32 ビット、それ以外は上下 32 ビット。
 */
export function parseLobLength(value: Uint8Array): number {
  const view = new DataView(value.buffer, value.byteOffset, value.byteLength);
  const width = view.getUint16(0);
  if (width === 0) return 0;
  if (width === 4) return value.length >= 6 ? view.getUint32(2) : 0;
  if (value.length >= 12) {
    // 上位 32 ビット ＋ 下位 32 ビット。JS の安全整数を超えるものは扱わない
    const upper = view.getUint32(4);
    const lower = view.getUint32(8);
    return upper * 0x1_0000_0000 + lower;
  }
  return 0;
}

function concat(chunks: readonly Uint8Array[], total: number): Uint8Array {
  const out = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return out;
}

function uint32(cp: number, value: number): { cp: number; value: Uint8Array } {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, value);
  return { cp, value: b };
}

function byte(cp: number, value: number): { cp: number; value: Uint8Array } {
  return { cp, value: Uint8Array.of(value & 0xff) };
}
