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
 * ## まとめ取りの要求形式は無い（原典で確認済み・2026-08-01）
 *
 * セルの数だけ往復する形は**原典も同じ**。`0x1816` はロケーターを 1 つしか取らず
 * （JTOpen `DBSQLRequestDS.setLOBLocatorHandle` は int 単数）、DB ホストサーバーの
 * 要求 ID を全列挙しても LOB 用は **取得 0x1816 / 書き込み 0x1817 / 解放 0x1819 の 3 つだけ**。
 * **自前でまとめ取りを組む道は無い**（`20260801-lob-batch-retrieval-research`）。
 *
 * 原典が往復を減らすのは**別の手段**——LOB フィールドしきい値（`0x3822`。
 * `db-connection.ts` 参照）を超えた LOB だけがロケーターになり、以下は行に載って返る。
 * JTOpen の既定は 32,768 バイト、上限は 15,728,640（公表は 16,777,216 だが通らない）。
 * **こちらは 0（＝常にロケーター）に倒している**——実測で応答が 8.4MB に膨らんだため。
 * 上げるなら行データの復号（`db-decode.ts` の 4 バイト読み）が変わるので実機確認が要る。
 *
 * 参照: jtopenlite の `DatabaseConnection.retrieveLOBData` /
 * `sendRetrieveLOBDataRequest` に対応する（事実に基づく書き起こし）。
 */
import { As400Error } from "@as400web/base";
import { childLog } from "@as400web/base";
import { findParam } from "../datastream.js";
import { DB_CP, DB_REQ, ORS } from "./db-datastream.js";
import { isTwoByteCcsid } from "./db-decode.js";
import type { DbConnection } from "./db-connection.js";

const log = childLog({ component: "hostserver-lob" });

/**
 * 一度に要求する量。**単位はホストと同じ「文字」**（`20260802-lob-multi-segment`）。
 *
 * 名前が `SEGMENT_BYTES` だった頃、これをバイトのつもりで `lobStartOffset` に流し込み、
 * **2 バイト CCSID の分割受信で位置が 2 倍に飛んで中身が抜けていた**。
 * 直したあとに同じ名前を残さない——名前が単位を偽っていたのが入口だった。
 *
 * 値は原典が 64KB のバッファで分割受信するのに合わせている。
 */
const SEGMENT_UNITS = 0xffff;
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
 *
 * ## ⚠ ホストは位置も要求量も「文字」で数える
 *
 * `lobStartOffset` / `lobRequestedSize` / 応答の長さ / 総長——**全部が文字単位**
 * （実機で確認。`20260802-lob-multi-segment` の research F1〜F3）。
 * 2 バイト CCSID（UTF-16 / 純 DBCS）では **1 文字 = 2 バイト**なので、
 * ここにバイト数を入れると位置が 2 倍に飛ぶ。
 *
 * だから**ループはホストと同じ単位（文字）で回し、換算は上限（バイト）を当てるときだけ**行う。
 *
 * `opts.startOffset` も**文字**。呼び出し元（`fillLobs`）は常に省略している。
 */
export async function retrieveLob(
  conn: DbConnection,
  locator: number,
  opts: { maxBytes?: number; startOffset?: number } = {}
): Promise<RetrievedLob> {
  const maxBytes = opts.maxBytes ?? DEFAULT_LOB_MAX_BYTES;
  /** ホストへ送る位置。**文字で数える** */
  let offsetUnits = opts.startOffset ?? 0;
  const chunks: Uint8Array[] = [];
  /** 上限判定に使う量。**こちらはバイト** */
  let receivedBytes = 0;
  let ccsid = 0;
  /**
   * 1 文字あたりのバイト数。**最初の応答の CCSID で確定する**ので、それまでは 1 と見なす。
   * そのぶん 1 周目だけ上限を超えて届きうる（最大 1 セグメント）——最後に切り詰める。
   */
  let perChar = 1;
  /** ホストが申告した総長。**文字数**（バイトへの換算は最後） */
  let totalUnits = 0;

  for (;;) {
    const remainingBytes = maxBytes - receivedBytes;
    if (remainingBytes <= 0) break;
    // **文字で頼む**（`perChar` 判明後は残りバイト数から割り出す）
    const wantUnits = Math.min(SEGMENT_UNITS, Math.ceil(remainingBytes / perChar));
    // 0 を頼まない。**いまの式では起きない**が、刻み方を変えたときに
    // 「0 を頼んで空が返る」空回りへ落ちるのを塞いでおく
    if (wantUnits <= 0) break;

    const reply = await conn.request({
      reqId: DB_REQ.retrieveLobData,
      orsBitmap: ORS.sendReplyImmediately | ORS.dataFormat | ORS.resultData,
      params: [
        uint32(DB_CP.lobLocatorHandle, locator),
        uint32(DB_CP.lobRequestedSize, wantUnits),
        uint32(DB_CP.lobStartOffset, offsetUnits),
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
    if (rawLength && rawLength.length >= 2 && totalUnits === 0) {
      totalUnits = parseLobLength(rawLength);
    }

    const rawData = findParam(reply, DB_CP.lobData);
    if (!rawData || rawData.length < 2) break;

    const view = new DataView(rawData.buffer, rawData.byteOffset, rawData.byteLength);
    ccsid = view.getUint16(0);
    // **長さの単位は CCSID で変わる**——UTF-16 / 純 DBCS では【文字数】、
    // それ以外は【バイト数】。バイト数として読むと `日本語`（3 文字 / 6 バイト）が
    // 3 バイトに切られる（実機で踏んだ。`20260801-dbclob-locator-decode`）。
    // **SBCS だけで試すと一致してしまい判別できない**
    perChar = isTwoByteCcsid(ccsid) ? 2 : 1;
    // **本体が無くても CCSID までは読んでから抜ける。** 総長（文字数）をバイトへ
    // 換算するのに要る——先に抜けると「総長は分かっているのに単位が分からない」ことになり、
    // 2 バイト CCSID の申告が半分の値で返る
    if (rawData.length <= 6) break;
    const declaredBytes = view.getUint32(2) * perChar;
    const body = rawData.subarray(6, Math.min(6 + declaredBytes, rawData.length));
    // **申告値ではなく、届いたバイト数から文字数を割り出す。** 応答が途中で切れたときに
    // 申告どおり進めると、届いていない分を飛ばす。半端な符号単位は混ぜない
    const gotUnits = Math.floor(body.length / perChar);
    if (gotUnits <= 0) break;
    const used = body.subarray(0, gotUnits * perChar);

    chunks.push(used);
    receivedBytes += used.length;
    offsetUnits += gotUnits;

    if (totalUnits > 0) {
      if (offsetUnits >= totalUnits) break;
    } else if (gotUnits < wantUnits) {
      // **総長が分からないときだけ、短い応答を終端と見なす。**
      // 総長が分かっているなら短い応答は「ホストが返せた分」でしかなく、
      // ここで止めると途中で切れた値を全部だと思い込む
      break;
    }
  }

  const totalLength = totalUnits * perChar;
  const bytes = trimToBytes(concat(chunks, receivedBytes), maxBytes, perChar);
  const truncated = totalLength > 0 && bytes.length < totalLength;
  log.debug(`retrieved LOB ${locator}: ${bytes.length}/${totalLength} bytes ccsid=${ccsid}`);
  return { bytes, ccsid, totalLength: totalLength || bytes.length, truncated };
}

/**
 * 上限バイト数へ切り詰める。
 *
 * `perChar` は最初の応答まで分からないので**1 周目だけ多めに届きうる**
 * （最大 1 セグメント）。戻り値としての約束——`maxBytes` を超えない——はここで守る。
 *
 * - 切るのは **`perChar` の倍数**の位置。UTF-16 を奇数バイトで切ると末尾が化ける。
 * - **末尾が上位サロゲート単独になるならもう 1 単位落とす。** 対の途中で切ると
 *   孤立サロゲートが残り、「打ち切られた」ではなく「壊れた」ように見える。
 */
function trimToBytes(bytes: Uint8Array, maxBytes: number, perChar: number): Uint8Array {
  if (bytes.length <= maxBytes) return bytes;
  let end = maxBytes - (maxBytes % perChar);
  if (perChar === 2 && end >= 2) {
    const last = (bytes[end - 2]! << 8) | bytes[end - 1]!;
    if (last >= 0xd800 && last <= 0xdbff) end -= 2;
  }
  return bytes.subarray(0, Math.max(0, end));
}

/**
 * LOB データ長（CP `0x3810`）を読む。
 * 先頭 2 バイトが長さの幅——0 なら長さなし、4 なら 32 ビット、それ以外は上下 32 ビット。
 */
/**
 * 「そのロケーターはもう無い」を表す戻りコード。
 * `-401` は原典のコメントが挙げる値、`-816` は**実機（7.3）が実際に返した値**。
 * どちらも二重解放の合図なので騒がない。
 */
const ALREADY_FREED: ReadonlySet<number> = new Set([-401, -816]);

/**
 * ロケーターを解放する（`0x1819`）。
 *
 * **後始末なので、失敗しても投げない。** 呼び出し側の目的は既に果たされており、
 * ここで例外にすると「値は取れたのに落ちる」ことになる。原典も同じ
 * （`JDLobLocator.free()` は戻りのエラーを読み捨てる。コメントに
 * `7,-401 signals already free` / `host now has various errors if locator is already freed`）。
 *
 * ただし**黙らせない**——`warn` で残す。既定の sink で消える `debug` にすると、
 * 解放が効いていないことに誰も気づけない（`20260801-sql-lob-failed-state` で踏んだ）。
 *
 * @returns 解放要求が戻りコード 0 で返ったら true
 */
export async function freeLob(conn: DbConnection, locator: number): Promise<boolean> {
  try {
    const reply = await conn.request({
      reqId: DB_REQ.freeLob,
      // **結果データを要求しない**（原典も RETURN_DATA のみ）
      orsBitmap: ORS.sendReplyImmediately,
      params: [uint32(DB_CP.lobLocatorHandle, locator)],
      allowTemplateError: true
    });
    const t = reply.dbTemplate;
    if (t.rcClass !== 0) {
      // **解放済みなら目的は達している**ので騒がない。
      // 原典のコメントは `7 / -401` を「既に解放済み」の合図として挙げるが、
      // **実機（IBM i 7.3）は `2 / -816` を返した**——原典自身が
      // 「host now has various errors if locator is already freed」と書いており、
      // **ホストや版数で変わる**。どちらも「もう無い」なので同じ扱いにする
      // （`20260801-lob-locator-free`）
      const already = ALREADY_FREED.has(t.rcClassReturnCode);
      const line = `LOB ${locator} の解放が拒まれた（rcClass=${t.rcClass}, code=${t.rcClassReturnCode}）`;
      if (already) log.debug(`${line}——既に解放済み`);
      else log.warn(line);
      return false;
    }
    return true;
  } catch (e) {
    log.warn(`LOB ${locator} の解放に失敗: ${String(e)}`);
    return false;
  }
}

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
