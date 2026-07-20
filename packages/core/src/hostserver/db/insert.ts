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
import { findParam } from "../datastream.js";
import { DB_CP, DB_REQ, ORS, isDbTemplateError } from "./db-datastream.js";
import type { DbConnection, DbReply } from "./db-connection.js";
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
 * **実機（PUB400）で測って妥当性を確認した値**である。
 * `(ID INTEGER, S CHAR(50))` の表（1 行 58 バイト）で 1MB = 18,078 行/バッチ となり、
 * そこまで一度も失敗しなかった:
 *
 * | 行数 | 所要 | 往復 |
 * |---|---|---|
 * | 10,000 | 3.1 秒 | **1** |
 * | 20,000 | 5.0 秒 | 2 |
 *
 * server 側の受理上限が 10,000 行なので、**現実の 1 回の取り込みは必ず 1 往復に収まる**。
 * サーバー側の限界には当たらなかったが、これ以上広げてもメモリを掴むだけで得が無いため
 * ここで止める。
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
    // **SQLCA も要求する**。立てないと応答に SQLCA が無く、
    // サーバーが形式を拒んでも「判定材料が無い」状態になる
    orsBitmap: ORS.sendReplyImmediately | ORS.sqlca | ORS.messageId | ORS.firstLevelText,
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
  // **書き込みは「成功と確認できたときだけ」通す**。SQLCA が読めない応答は
  // 成否を判定できないので失敗として扱う（巻き戻せない経路なので安全側に倒す）
  assertOk(reply, "行を追加できませんでした", { requireSqlca: true });

  // 申告された更新件数と送った件数が食い違えば、成功とは言えない
  const rawCa = findParam(reply, DB_CP.sqlca);
  const ca = rawCa ? parseSqlca(rawCa) : undefined;
  if (ca !== undefined && ca.updateCount >= 0 && ca.updateCount !== batch.length) {
    throw new As400Error(
      "SQL_ERROR",
      `追加された行数が一致しません（送信 ${batch.length} / サーバー申告 ${ca.updateCount}）`
    );
  }
}

/**
 * 応答を検査する。**成功と言い切れるときだけ通す**。
 *
 * 見るのは 2 つ:
 *
 * 1. **template の戻りコード**（`rcClass !== 0` が失敗）。
 * 2. **SQLCA の SQLCODE**（負が失敗）。
 *
 * メッセージ ID の頭文字では判定できない——成功時にも
 * `L7956 n rows inserted` や `S0002 Function completed successfully.` が返るためで、
 * 実際に `S` を失敗と見なす実装にして誤検知した。
 *
 * ⚠ **SQLCA が無い応答を成功扱いにしない**。以前は `undefined` を素通りさせており、
 * 「template はエラーだが SQLCA が無い」応答が黙って成功として通る穴があった。
 * この経路は書き込みなので、判定できない応答は失敗として扱う。
 *
 * `allowTemplateError: true` で要求を出しているのは、**メッセージ本文（`0x3802`）を
 * 添えてから投げる**ため。`request()` に投げさせると理由が付かない。
 */
function assertOk(reply: DbReply, what: string, opts: { requireSqlca?: boolean } = {}): void {
  const rawCa = findParam(reply, DB_CP.sqlca);
  const ca = rawCa ? parseSqlca(rawCa) : undefined;
  const templateFailed = isDbTemplateError(reply.dbTemplate);
  const sqlFailed = ca !== undefined && ca.sqlCode < 0;
  // 書き込みでは**判定できない応答を成功にしない**（`parseSqlca` は短い応答で undefined を返す）
  const undecidable = opts.requireSqlca === true && ca === undefined;
  if (!templateFailed && !sqlFailed && !undecidable) return;
  if (undecidable && !templateFailed) {
    throw new As400Error("SQL_ERROR", `${what}: 応答に SQLCA が無く成否を判定できません`);
  }

  const id = findParam(reply, DB_CP.messageId);
  const text = findParam(reply, DB_CP.messageText);
  const detail = [
    id ? decodeIdentifier(id).trim() : "",
    text ? decodeIdentifier(text).trim() : ""
  ]
    .filter(Boolean)
    .join(" ");
  const why = sqlFailed
    ? `SQLCODE=${ca!.sqlCode} SQLSTATE=${ca!.sqlState}`
    : `rcClass=${reply.dbTemplate.rcClass} rc=${reply.dbTemplate.rcClassReturnCode}`;
  throw new As400Error("SQL_ERROR", `${what}: ${why}${detail ? ` ${detail}` : ""}`);
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
