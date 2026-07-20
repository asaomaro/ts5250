/**
 * 表への行追加（パラメータマーカー付き INSERT）。
 *
 * **`prepareAndDescribe` → `changeDescriptor` → `execute` の 3 段は
 * 分けられない 1 つの操作**である。間に別の SQL を流すと、同じ RPB に別の文が
 * 準備されてこちらの文が失われ、`Prepared statement not found` になる
 * （スパイクで実際に踏んだ）。よって 3 段をこの関数の中で完結させ、
 * 呼び出し側が割り込める形の API を公開しない。
 *
 * ⚠ この関数を呼んでいる間、その接続に他の SQL を流してはならない。
 *
 * ⚠ **コミットメント制御は使わない**。途中のバッチで失敗しても、
 * それまでに書いた行は残る。何行目まで確定したかは応答から特定できないため、
 * 「確定した行数」と「確定不明な範囲」を分けて返す。
 *
 * 参照: jtopenlite `JDBCPreparedStatement`（コンストラクタの prepareAndDescribe →
 * changeDescriptor）と `JDBCStatement.execute`。逐語移植ではない。
 */
import { As400Error } from "../../errors.js";
import { childLog } from "../../log.js";
import { codecForCcsid } from "../../codec/codec.js";
import { findParam, type Reply } from "../datastream.js";
import { DB_CP, DB_REQ, ORS } from "./db-datastream.js";
import type { DbConnection } from "./db-connection.js";
import { parseSqlca } from "./db-reply.js";
import { parseMarkerFormat, type MarkerFormat } from "./marker-format.js";
import { buildMarkerData, encodeMarkerRow, markerDataSize, MarkerEncodeError } from "./marker-encode.js";

const log = childLog({ component: "hostserver-sql-insert" });

/** SQL 文テキストの CCSID（UTF-16）。日本語もこのまま届く */
const SQL_TEXT_CCSID = 13488;
/** 文名・カーソル名の CCSID */
const IDENTIFIER_CCSID = 37;
/** 文の種別。1 = INSERT / UPDATE / DELETE */
const STATEMENT_TYPE_INSERT = 1;
/** この経路が使う文名。取り込み中は接続を占有するので固定でよい */
const STATEMENT_NAME = "ASUPLOAD";
/**
 * マーカーのディスクリプタハンドル。RPB ハンドル（1）とは**別の欄**に載る。
 * 取り違えると準備した文を見失い、エラーにならないまま何も起きない。
 */
const DESCRIPTOR_HANDLE = 2;

/**
 * 1 バッチのマーカーデータの上限（バイト）。
 *
 * 実測して決めた値ではなく**保守的な既定**である（spec D4）。
 * 長さ欄は 4 バイトなので形式上の余裕は大きいが、上限は未確認。
 * 実機で詰めるまではここで抑える。
 */
export const DEFAULT_MAX_BATCH_BYTES = 1024 * 1024;

export interface InsertResult {
  /** 書き込みが確定した行数（確実に書けた下限） */
  committedRows: number;
  /**
   * 失敗したバッチの行範囲（1 始まり）。この範囲は**書けたか書けなかったか不明**。
   * 成功時は付かない。
   */
  uncertainRange?: { from: number; to: number };
  /** 失敗の理由（`uncertainRange` があるときのみ） */
  error?: string;
  /** 1 バッチに詰めた行数 */
  batchSize: number;
}

/** 値を詰められなかった行の情報。呼び出し側が行番号つきで報告できるようにする */
export class InsertEncodeError extends As400Error {
  constructor(
    /** CSV のデータ行番号（1 始まり） */
    readonly row: number,
    readonly columnIndex: number,
    message: string,
    code: "UNSUPPORTED_TYPE" | "CONFIG_ERROR"
  ) {
    super(code, message);
    this.name = "InsertEncodeError";
  }
}

export interface InsertRowsArgs {
  library: string;
  table: string;
  /** 挿入する列名。**表の実列名**を渡すこと（CSV のヘッダーをそのまま渡さない） */
  columns: readonly string[];
  /** 値。列数ぶんの文字列 or null */
  rows: readonly (readonly (string | null)[])[];
  maxBatchBytes?: number;
}

export async function insertRows(
  conn: DbConnection,
  args: InsertRowsArgs
): Promise<InsertResult> {
  const { library, table, columns, rows } = args;
  if (columns.length === 0) throw new As400Error("CONFIG_ERROR", "列がありません");
  if (rows.length === 0) return { committedRows: 0, batchSize: 0 };

  const sql =
    `INSERT INTO ${library}.${table} (${columns.join(", ")}) ` +
    `VALUES (${columns.map(() => "?").join(", ")})`;

  // --- 1. 準備してマーカー形式を受け取る ---
  const format = await prepareAndDescribe(conn, sql);
  if (format.fields.length !== columns.length) {
    throw new As400Error(
      "PROTOCOL_ERROR",
      `マーカーの数が列数と一致しません（列 ${columns.length} / マーカー ${format.fields.length}）`
    );
  }

  // --- 2. 全行を詰める。**送る前に全部**（1 行も書かずに中止できるようにする） ---
  const encoded = rows.map((values, i) => {
    try {
      return encodeMarkerRow(format, values);
    } catch (e) {
      if (e instanceof MarkerEncodeError) {
        throw new InsertEncodeError(
          i + 1,
          e.columnIndex,
          e.message,
          e.code === "UNSUPPORTED_TYPE" ? "UNSUPPORTED_TYPE" : "CONFIG_ERROR"
        );
      }
      throw e;
    }
  });

  // --- 3. 形式を登録して実行する ---
  await changeDescriptor(conn, format);

  const batchSize = batchSizeFor(format, args.maxBatchBytes ?? DEFAULT_MAX_BATCH_BYTES);
  let committed = 0;
  while (committed < encoded.length) {
    const slice = encoded.slice(committed, committed + batchSize);
    try {
      await executeBatch(conn, format, slice);
    } catch (e) {
      log.warn(
        `partial insert into ${library}.${table}: committed=${committed} ` +
          `failed rows ${committed + 1}-${committed + slice.length}: ${String(e)}`
      );
      return {
        committedRows: committed,
        uncertainRange: { from: committed + 1, to: committed + slice.length },
        error: e instanceof Error ? e.message : String(e),
        batchSize
      };
    }
    committed += slice.length;
  }
  return { committedRows: committed, batchSize };
}

/** 上限バイト数に収まる行数。**最低 1 行は送る**（0 だと進まなくなる） */
export function batchSizeFor(format: MarkerFormat, maxBytes: number): number {
  const perRow = markerDataSize(format, 1) - markerDataSize(format, 0);
  if (perRow <= 0) return 1;
  return Math.max(1, Math.floor((maxBytes - markerDataSize(format, 0)) / perRow));
}

async function prepareAndDescribe(conn: DbConnection, sql: string): Promise<MarkerFormat> {
  const reply = await conn.request({
    reqId: DB_REQ.prepareAndDescribe,
    orsBitmap:
      ORS.sendReplyImmediately |
      ORS.sqlca |
      ORS.parameterMarkerFormat |
      ORS.extendedColumnDescriptors |
      ORS.messageId |
      ORS.firstLevelText,
    params: [
      identifier(DB_CP.prepareStatementName, STATEMENT_NAME),
      sqlText(DB_CP.sqlStatementText, sql),
      num(DB_CP.sqlStatementType, STATEMENT_TYPE_INSERT, 2)
    ],
    allowTemplateError: true
  });
  assertOk(reply, "INSERT 文を準備できませんでした");

  const raw = findParam(reply, DB_CP.parameterMarkerFormat);
  if (!raw) {
    throw new As400Error("PROTOCOL_ERROR", "マーカー形式が返りませんでした");
  }
  return parseMarkerFormat(raw);
}

async function changeDescriptor(conn: DbConnection, format: MarkerFormat): Promise<void> {
  const reply = await conn.request({
    reqId: DB_REQ.changeDescriptor,
    orsBitmap: ORS.sendReplyImmediately | ORS.messageId | ORS.firstLevelText,
    // **RPB ハンドルではなくマーカーのハンドル欄**（template のオフセット 16）
    parameterMarkerHandle: DESCRIPTOR_HANDLE,
    params: [{ cp: DB_CP.extendedParameterMarkerFormat, value: format.raw }],
    allowTemplateError: true
  });
  assertOk(reply, "マーカー形式を登録できませんでした");
}

async function executeBatch(
  conn: DbConnection,
  format: MarkerFormat,
  batch: readonly { data: Uint8Array; nulls: boolean[] }[]
): Promise<void> {
  const reply = await conn.request({
    reqId: DB_REQ.execute,
    // **診断ビットを常に立てる**。立てないと失敗が空の SQLCA だけになり原因が分からない
    orsBitmap: ORS.sendReplyImmediately | ORS.sqlca | ORS.messageId | ORS.firstLevelText,
    parameterMarkerHandle: DESCRIPTOR_HANDLE,
    params: [
      identifier(DB_CP.prepareStatementName, STATEMENT_NAME),
      num(DB_CP.sqlStatementType, STATEMENT_TYPE_INSERT, 2),
      { cp: DB_CP.extendedParameterMarkerData, value: buildMarkerData(format, batch) }
    ],
    allowTemplateError: true
  });
  assertOk(reply, "行を追加できませんでした");
}

/**
 * 応答を検査する。
 *
 * **成否は SQLCA の SQLCODE で判定する**（負なら失敗）。
 * メッセージ ID の頭文字では判定できない——成功時にも
 * `L7956 n rows inserted` や `S0002 Function completed successfully.` が返るためで、
 * 実際に `S` を失敗と見なす実装にして誤検知した。
 *
 * メッセージは**理由の説明**として添える（`ORS.messageId | firstLevelText` を
 * 立てているのはこのため。立てないと失敗が空の SQLCA だけになる）。
 */
function assertOk(reply: Reply, what: string): void {
  const rawCa = findParam(reply, DB_CP.sqlca);
  const ca = rawCa ? parseSqlca(rawCa) : undefined;
  if (ca === undefined || ca.sqlCode >= 0) return;

  const id = findParam(reply, DB_CP.messageId);
  const text = findParam(reply, DB_CP.messageText);
  const detail = [
    id ? decodeIdentifier(id).trim() : "",
    text ? decodeIdentifier(text).trim() : ""
  ]
    .filter(Boolean)
    .join(" ");
  throw new As400Error(
    "SQL_ERROR",
    `${what}: SQLCODE=${ca.sqlCode} SQLSTATE=${ca.sqlState}${detail ? ` ${detail}` : ""}`
  );
}

/** 文字列パラメータ。CCSID(2) ＋ 長さ(2) ＋ 本体 */
function sqlText(cp: number, value: string): { cp: number; value: Uint8Array } {
  const out = new Uint8Array(4 + value.length * 2);
  const view = new DataView(out.buffer);
  view.setUint16(0, SQL_TEXT_CCSID);
  view.setUint16(2, value.length * 2);
  for (let i = 0; i < value.length; i++) view.setUint16(4 + i * 2, value.charCodeAt(i));
  return { cp, value: out };
}

function identifier(cp: number, value: string): { cp: number; value: Uint8Array } {
  const { bytes } = codecForCcsid(IDENTIFIER_CCSID).encode(value);
  const out = new Uint8Array(4 + bytes.length);
  const view = new DataView(out.buffer);
  view.setUint16(0, IDENTIFIER_CCSID);
  view.setUint16(2, bytes.length);
  out.set(bytes, 4);
  return { cp, value: out };
}

function num(cp: number, value: number, size: 2 | 4): { cp: number; value: Uint8Array } {
  const out = new Uint8Array(size);
  const view = new DataView(out.buffer);
  if (size === 2) view.setUint16(0, value);
  else view.setUint32(0, value);
  return { cp, value: out };
}

/** 応答のメッセージは CCSID 37 ＋ 先頭 4 バイトが CCSID/長さ */
function decodeIdentifier(value: Uint8Array): string {
  return codecForCcsid(IDENTIFIER_CCSID).decode(value.subarray(4));
}
