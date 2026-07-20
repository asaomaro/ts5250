/**
 * SQL の実行と結果取得。
 *
 * 手順は `prepare + describe` → `open + describe` → `fetch`。
 * `executeImmediate` では**列メタデータが得られない**ため使わない
 * （原典にも「Just a plain prepare doesn't give us extended column metadata back」とある）。
 *
 * 参照: JTOpen(jtopenlite) の JDBCStatement.executeQuery /
 *       DatabaseConnection.prepareAndDescribe / openAndDescribe / fetch に対応する。
 */
import { As400Error } from "../../errors.js";
import { childLog } from "../../log.js";
import { findParam, type Reply } from "../datastream.js";
import { codecForCcsid } from "../../codec/codec.js";
import { DB_REQ, DB_CP, ORS } from "./db-datastream.js";
import { DbConnection } from "./db-connection.js";
import { parseDataFormat, parseResultData, parseSqlca, type ResultFormat } from "./db-reply.js";
import {
  parseExtendedResultData,
  parseSuperExtendedDataFormat,
  type ExtColumn
} from "./db-reply-ext.js";
import { decodeRow, type ColumnMeta, type DbValue, type LobPlaceholder } from "./db-decode.js";
import { typeName, jsTypeOf } from "./db-types.js";
import { retrieveLob, DEFAULT_LOB_MAX_BYTES } from "./lob.js";

const log = childLog({ component: "hostserver-sql" });

/** SQL 文の種別。SELECT を指定しないと拡張列メタデータが返らない */
const STATEMENT_TYPE_SELECT = 0;
/** 拡張列記述子を要求する値。これが無いと列定義が簡易形式で返る */
const EXTENDED_COLUMN_DESCRIPTOR = 0xf1;
/** SELECT のオープン属性 */
const OPEN_ATTR_SELECT = 0x80;
/** 既定のブロッキング係数（1 回の fetch で取る行数） */
const DEFAULT_BLOCK_SIZE = 100;
/** 本実装が使うカーソル名・文名 */
const CURSOR_NAME = "C1";
const STATEMENT_NAME = "S1";

export type Row = Record<string, DbValue>;

export interface QueryResult {
  columns: ColumnMeta[];
  rows: Row[];
}

/** SQL の実行エラー。SQLCODE / SQLSTATE を**型として**公開する */
export class SqlError extends As400Error {
  constructor(
    readonly sqlCode: number,
    readonly sqlState: string,
    message: string
  ) {
    super("SQL_ERROR", message);
    this.name = "SqlError";
  }
}

/** SQL 文で使う CCSID（UTF-16）。原典が 13488 を送っている */
const SQL_TEXT_CCSID = 13488;
/** 識別子（文名・カーソル名）は CCSID 37 の EBCDIC */
const IDENTIFIER_CCSID = 37;

/** 数値パラメータ */
function num(cp: number, value: number, width: 2 | 4): { cp: number; value: Uint8Array } {
  const b = new Uint8Array(width);
  const v = new DataView(b.buffer);
  if (width === 2) v.setUint16(0, value);
  else v.setUint32(0, value);
  return { cp, value: b };
}

/**
 * 文字列パラメータ。CCSID(2) ＋ 長さ(2) ＋ 本体。
 *
 * **長さの単位が用途で違う**——SQL 文（UTF-16）は文字数、
 * 識別子（EBCDIC）はバイト数を書く。原典の writeSQLStatementText /
 * writePrepareStatementName に合わせる。
 */
function sqlText(cp: number, value: string): { cp: number; value: Uint8Array } {
  const out = new Uint8Array(4 + value.length * 2);
  const v = new DataView(out.buffer);
  v.setUint16(0, SQL_TEXT_CCSID);
  v.setUint16(2, value.length * 2);
  for (let i = 0; i < value.length; i++) v.setUint16(4 + i * 2, value.charCodeAt(i));
  return { cp, value: out };
}

/** 1 バイトのパラメータ */
function byteParam(cp: number, value: number): { cp: number; value: Uint8Array } {
  return { cp, value: Uint8Array.from([value & 0xff]) };
}

/** 識別子（文名・カーソル名）。CCSID 37 の EBCDIC */
function identifier(cp: number, value: string): { cp: number; value: Uint8Array } {
  const { bytes } = codecForCcsid(IDENTIFIER_CCSID).encode(value);
  const out = new Uint8Array(4 + bytes.length);
  const v = new DataView(out.buffer);
  v.setUint16(0, IDENTIFIER_CCSID);
  v.setUint16(2, bytes.length);
  out.set(bytes, 4);
  return { cp, value: out };
}

/** SQLCA を見て、エラーなら例外にする */
function checkSqlca(reply: Reply, what: string): void {
  const raw = findParam(reply, DB_CP.sqlca);
  if (!raw) return;
  const ca = parseSqlca(raw);
  if (!ca) return;
  if (ca.sqlCode < 0) {
    throw new SqlError(
      ca.sqlCode,
      ca.sqlState,
      `${what} failed: SQLCODE=${ca.sqlCode} SQLSTATE=${ca.sqlState}`
    );
  }
  if (ca.sqlCode > 0) {
    log.debug(`${what}: SQLCODE=${ca.sqlCode} SQLSTATE=${ca.sqlState} (warning)`);
  }
}

/** SELECT を実行して全行を返す */
export interface LobOptions {
  /** 1 セルあたりの取得上限。既定 64KB。**既定では取りに行かない** */
  maxBytes?: number;
}

export async function query(
  conn: DbConnection,
  sql: string,
  opts: { blockSize?: number; lob?: LobOptions } = {}
): Promise<QueryResult> {
  const release = conn.acquire();
  try {
    const format = await prepareAndOpen(conn, sql);
    const rows: Row[] = [];
    try {
      for await (const row of fetchAll(conn, format, opts.blockSize ?? DEFAULT_BLOCK_SIZE)) {
        rows.push(row);
      }
    } finally {
      // 途中でエラーが出てもサーバー側のカーソルを残さない
      await closeCursor(conn);
    }
    // **LOB は同じ接続の中で取り切る**——ロケーターは接続に紐づくため、
    // 呼び出し側が後から取ることはできない（lob.ts の説明を参照）
    if (opts.lob) await fillLobs(conn, rows, opts.lob);
    return { columns: format.columns, rows };
  } finally {
    release();
  }
}

/** SELECT を実行して 1 行ずつ返す（大きな結果セット向け） */
export async function* stream(
  conn: DbConnection,
  sql: string,
  opts: { blockSize?: number } = {}
): AsyncGenerator<Row, void, undefined> {
  const release = conn.acquire();
  try {
    const format = await prepareAndOpen(conn, sql);
    try {
      yield* fetchAll(conn, format, opts.blockSize ?? DEFAULT_BLOCK_SIZE);
    } finally {
      await closeCursor(conn);
    }
  } finally {
    release();
  }
}

/** prepare + describe → open + describe。列定義を返す */
async function prepareAndOpen(conn: DbConnection, sql: string): Promise<ResultFormat> {
  const prepared = await conn.request({
    reqId: DB_REQ.prepareAndDescribe,
    orsBitmap:
      ORS.sendReplyImmediately | ORS.dataFormat | ORS.extendedColumnDescriptors | ORS.sqlca,
    params: [
      identifier(DB_CP.prepareStatementName, STATEMENT_NAME),
      sqlText(DB_CP.sqlStatementText, sql),
      num(DB_CP.sqlStatementType, STATEMENT_TYPE_SELECT, 2),
      byteParam(DB_CP.openAttributes, OPEN_ATTR_SELECT),
      byteParam(DB_CP.extendedColumnDescriptorOption, EXTENDED_COLUMN_DESCRIPTOR)
    ],
    allowTemplateError: true
  });
  checkSqlca(prepared, "prepare");

  // **超拡張形式を優先**。接続時に 0x3821 を送っているので通常はこちらが返る。
  // 元形式も見るのは、0xF2 を受け付けないホストが見つかったときに戻せるようにするため
  const rawExt = findParam(prepared, DB_CP.superExtendedDataFormat);
  if (rawExt && rawExt.length > 0) {
    const ext = parseSuperExtendedDataFormat(rawExt);
    const format: ResultFormat = {
      columns: ext.columns.map(toColumnMeta),
      recordSize: ext.recordSize
    };
    log.debug(`prepared (super extended): ${format.columns.length} columns, record size ${format.recordSize}`);
    await openCursor(conn);
    return format;
  }

  const rawFormat = findParam(prepared, DB_CP.dataFormat);
  // 空のパラメータ（長さ 0）で返ることがあるので `!rawFormat` だけでは足りない
  if (!rawFormat || rawFormat.length === 0) {
    // **握り潰していた戻りコードを診断に出す**。`allowTemplateError: true` で
    // template のエラーを通しているため、ここまで来ても「列定義が無い」ことしか
    // 分からず、原因（文の種類・未対応の型・権限）を切り分けられなかった。
    const t = prepared.dbTemplate;
    throw new As400Error(
      "PROTOCOL_ERROR",
      `この結果セットは取得できません（rcClass=${t.rcClass}, code=${t.rcClassReturnCode}）。` +
        "SELECT 以外の文か、このホストが超拡張データ形式を受け付けない可能性があります"
    );
  }
  const format = parseDataFormat(rawFormat);
  log.debug(`prepared: ${format.columns.length} columns, record size ${format.recordSize}`);

  await openCursor(conn);
  return format;
}

async function openCursor(conn: DbConnection): Promise<void> {
  const opened = await conn.request({
    reqId: DB_REQ.openAndDescribe,
    orsBitmap: ORS.sendReplyImmediately | ORS.dataFormat | ORS.sqlca,
    params: [
      identifier(DB_CP.prepareStatementName, STATEMENT_NAME),
      identifier(DB_CP.cursorName, CURSOR_NAME)
    ],
    allowTemplateError: true
  });
  checkSqlca(opened, "open cursor");
}

/** 超拡張形式の列を既存の ColumnMeta に写す（下流はこの型だけを見る） */
function toColumnMeta(c: ExtColumn): ColumnMeta {
  // 型コードは NULL 可なら +1 されている（元形式と同じ規則）
  const nullable = c.sqlType % 2 === 1;
  const type = nullable ? c.sqlType - 1 : c.sqlType;
  return {
    name: c.name,
    type,
    typeName: typeName(type),
    offset: c.offset,
    length: c.length,
    scale: c.scale,
    precision: c.precision,
    ccsid: c.ccsid,
    nullable,
    jsType: jsTypeOf(type),
    ...(c.lobLocator ? { lobLocator: c.lobLocator, lobMaxSize: c.lobMaxSize } : {})
  };
}

/** 行が尽きるまで fetch を繰り返す */
async function* fetchAll(
  conn: DbConnection,
  format: ResultFormat,
  blockSize: number
): AsyncGenerator<Row, void, undefined> {
  for (;;) {
    const reply = await conn.request({
      reqId: DB_REQ.fetch,
      orsBitmap: ORS.sendReplyImmediately | ORS.resultData | ORS.sqlca,
      params: [
        identifier(DB_CP.cursorName, CURSOR_NAME),
        num(DB_CP.blockingFactor, blockSize, 4)
      ],
      allowTemplateError: true
    });

    const rawExt = findParam(reply, DB_CP.extendedResultData);
    if (rawExt !== undefined) {
      if (rawExt.length === 0) {
        checkSqlca(reply, "fetch");
        return;
      }
      const data = parseExtendedResultData(rawExt);
      for (let r = 0; r < data.rows.length; r++) {
        yield decodeRow(data.rows[r]!, format.columns, data.nulls[r] ?? []);
      }
      checkSqlca(reply, "fetch");
      if (data.rows.length < blockSize) return;
      continue;
    }

    const raw = findParam(reply, DB_CP.resultData);
    // **空のパラメータが返ることがある**（パラメータ自体は在るが長さ 0）。
    // 行数がブロッキング係数のちょうど倍数のとき、最後のブロックを取り切ったあとの
    // fetch が「SQLCODE 100 ＋ 長さ 0 の結果データ」で返る。`!raw` だけを見ていると
    // これをすり抜けて解析に入り `result data too short: 0 bytes` で落ちる。
    // 実機で確認: FETCH FIRST 100/200 は失敗、99/101 は成功（ブロック既定 100）。
    if (!raw || raw.length === 0) {
      // データが無い＝行が尽きた（SQLCODE 100 も同時に返る）
      checkSqlca(reply, "fetch");
      return;
    }
    const data = parseResultData(raw);
    for (let r = 0; r < data.rows.length; r++) {
      yield decodeRow(data.rows[r]!, format.columns, data.nulls[r] ?? []);
    }
    checkSqlca(reply, "fetch");
    if (data.rows.length < blockSize) return;
  }
}

/** 行の中のロケーターを本体で置き換える。既定では呼ばれない */
async function fillLobs(
  conn: DbConnection,
  rows: readonly Record<string, DbValue>[],
  opts: LobOptions
): Promise<void> {
  const maxBytes = opts.maxBytes ?? DEFAULT_LOB_MAX_BYTES;
  for (const row of rows) {
    for (const [key, value] of Object.entries(row)) {
      if (!isLobPlaceholder(value)) continue;
      try {
        const got = await retrieveLob(conn, value.locator, { maxBytes });
        const filled: LobPlaceholder = {
          kind: "lob",
          locator: value.locator,
          maxSize: value.maxSize,
          byteLength: got.totalLength,
          value: decodeLob(got.bytes, got.ccsid)
        };
        // 打ち切ったときだけ理由を残す（取れたなら unavailable は付けない）
        if (got.truncated) filled.unavailable = "too-large";
        row[key] = filled;
      } catch (e) {
        log.debug(`LOB ${value.locator} の取得に失敗: ${String(e)}`);
        row[key] = { ...value, unavailable: "not-requested" };
      }
    }
  }
}

function isLobPlaceholder(v: DbValue): v is LobPlaceholder {
  return typeof v === "object" && v !== null && (v as LobPlaceholder).kind === "lob";
}

/**
 * LOB のバイト列を、ホストが申告した CCSID で文字列にする。
 * **未知の CCSID なら Uint8Array のまま返す**（壊れた文字列にしない）。
 */
function decodeLob(bytes: Uint8Array, ccsid: number): string | Uint8Array {
  if (ccsid === 0) return bytes;
  try {
    return codecForCcsid(ccsid).decode(bytes);
  } catch {
    return bytes;
  }
}

async function closeCursor(conn: DbConnection): Promise<void> {
  try {
    await conn.request({
      reqId: DB_REQ.closeCursor,
      params: [identifier(DB_CP.cursorName, CURSOR_NAME)],
      allowTemplateError: true
    });
  } catch (e) {
    // 片付けの失敗で結果を捨てない
    log.debug(`close cursor failed: ${String(e)}`);
  }
}
