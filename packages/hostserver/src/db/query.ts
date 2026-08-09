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
import { As400Error } from "@ts5250/base";
import { childLog } from "@ts5250/base";
import { findParam, type Reply } from "../datastream.js";
import { codecForCcsid } from "@ts5250/ebcdic";
import { DB_REQ, DB_CP, ORS } from "./db-datastream.js";
import { DbConnection } from "./db-connection.js";
import { parseDataFormat, parseResultData, parseSqlca, type ResultFormat } from "./db-reply.js";
import {
  parseExtendedResultData,
  parseSuperExtendedDataFormat,
  type ExtColumn
} from "./db-reply-ext.js";
import { decodeRow, decodeLobBytes, type ColumnMeta, type DbValue, type LobPlaceholder } from "./db-decode.js";
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

/** 上限つき取得の結果 */
export interface LimitedResult extends QueryResult {
  /**
   * 上限で切ったか。**測った事実**（`limit + 1` 行目が読めたか）であって、
   * `rows.length === limit` からの推測ではない
   * ——推測にすると**上限ちょうどの結果セットで嘘になる**。
   */
  truncated: boolean;
}

/**
 * SELECT を**上限まで**取得する。上限に達したらカーソルを閉じて打ち切る。
 *
 * `query()` との違いは「**ホストから取ってくる量**」。`query()` は全件取得してから返すので、
 * 大きな表では全行がメモリに載る。実機での実測（20,000 行 × `CHAR(50)`）:
 *
 * | 取り方 | fetch 往復 | 受信バイト | 所要 |
 * |---|---|---|---|
 * | `query`（全件） | 201 | 1,191,336 | 2,072ms |
 * | `queryLimited`（上限 200） | 3 | 約 12,000 | 約 45ms |
 *
 * （3 往復目は「続きがあるか」を見る **1 行だけ**の要求）
 *
 * **途中でカーソルを閉じてもホストは健全**（同じ接続で次の SELECT も UPDATE も通る。
 * 上限 1/50/99/100/101/200/250 と 10 回連続で確認。
 * `20260730-sql-fetch-limit` research F1）。
 *
 * ⚠ `query()` にオプションを足す形にしていないのは、**渡し忘れると全件**になるため。
 * 入口を分けて「どちらの意味で読むか」を必ず選ばせる。
 */
export async function queryLimited(
  conn: DbConnection,
  sql: string,
  opts: { limit: number; lob?: LobOptions }
): Promise<LimitedResult> {
  if (!Number.isInteger(opts.limit) || opts.limit <= 0) {
    // **黙って全件にしない。** 上限のつもりで 0 を渡した呼び出しが全件取得になるのが最悪
    throw new As400Error("CONFIG_ERROR", `取得上限は 1 以上の整数で指定してください（${opts.limit}）`);
  }
  const limit = opts.limit;
  const release = conn.acquire();
  try {
    const format = await prepareAndOpen(conn, sql);
    const rows: Row[] = [];
    let truncated = false;
    try {
      // **上限＋1 行まで読む**。`limit + 1` 行目が読めたかが「続きがあるか」の答えで、
      // `rows.length === limit` からの推測にすると**上限ちょうどのときに嘘になる**
      for await (const row of fetchAll(conn, format, DEFAULT_BLOCK_SIZE, limit + 1)) {
        if (rows.length >= limit) {
          // **余りの 1 行は捨てる**（上限を 1 行超えて返さない）。読めた事実だけを使う
          truncated = true;
          break;
        }
        rows.push(row);
      }
    } finally {
      // 途中で打ち切っても・例外で抜けても**カーソルを残さない**。
      // 打ち切った後のホストが健全なことは実機で確認済み（research F1）
      await closeCursor(conn);
    }
    // **LOB は同じ接続の中で取り切る**——ロケーターは接続に紐づく（`query` と同じ順序）
    if (opts.lob) await fillLobs(conn, rows, opts.lob);
    return { columns: format.columns, rows, truncated };
  } finally {
    release();
  }
}

/**
 * カーソルを開いたまま「列定義」と「行のジェネレータ」を返す。
 *
 * `stream()` は列定義を返さないため、**画面のページング**のように
 * 列見出しが要る用途で使えない。`query()` は全件読んでカーソルを閉じてしまう。
 * その中間として、**呼び出し側がカーソルの寿命を握る**入口を用意する。
 *
 * ⚠ **返したジェネレータを最後まで回すか `return()` すること。**
 * 放置するとカーソルと接続が開いたままになる。
 */
export interface OpenedQuery {
  columns: ColumnMeta[];
  rows: AsyncGenerator<Row, void, undefined>;
  /**
   * カーソルを閉じて接続の占有を解く。**冪等**（何度呼んでもよい）。
   *
   * **`rows` を 1 度も回さないなら、これを呼ぶこと。** ジェネレータは本体が開始するまで
   * `finally` を実行しないため、`rows.return()` だけでは解放されない
   * （`20260802-sql-visual-explain` の research F9 で実測。以降その接続のすべての要求が
   * 「another query is in progress」になった）。
   */
  close: () => Promise<void>;
}

export async function openQuery(
  conn: DbConnection,
  sql: string,
  opts: { blockSize?: number } = {}
): Promise<OpenedQuery> {
  const release = conn.acquire();
  let format: ResultFormat;
  try {
    format = await prepareAndOpen(conn, sql);
  } catch (e) {
    // **開けなかったら占有を解く。** ここで解かないと、SQL の誤り 1 回でその接続が
    // 二度と使えなくなる（以降すべて「another query is in progress」）。
    // 実機で確認した（`20260730-sql-fetch-limit` decisions D1）——
    // 単発接続では接続ごと閉じるので隠れていたが、使い回す経路では致命的だった
    release();
    throw e;
  }
  const blockSize = opts.blockSize ?? DEFAULT_BLOCK_SIZE;
  let closed = false;
  async function close(): Promise<void> {
    if (closed) return;
    closed = true;
    try {
      await closeCursor(conn);
    } finally {
      // **`release` は finally に置く。** 以前は `closeCursor` の後に並べていたので、
      // カーソルを閉じる要求が失敗すると占有が解けずに接続が死んでいた
      release();
    }
  }
  async function* iterate(): AsyncGenerator<Row, void, undefined> {
    try {
      yield* fetchAll(conn, format, blockSize);
    } finally {
      await close();
    }
  }
  return { columns: format.columns, rows: iterate(), close };
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

/**
 * 超拡張形式の列を既存の ColumnMeta に写す（下流はこの型だけを見る）。
 *
 * **名前が空なら位置で名前を付ける。** 名前を返さない表がある（`QSYS2.SYSROUTINES` は
 * 実機で全列が空）。空のまま通すと**全列が同じ名前になり、行を連想配列にした時点で
 * 最後の 1 列以外が消える**——2 列の結果が 1 列になって画面に出た（実機で踏んだ）。
 */
function toColumnMeta(c: ExtColumn, index: number): ColumnMeta {
  // 型コードは NULL 可なら +1 されている（元形式と同じ規則）
  const nullable = c.sqlType % 2 === 1;
  const type = nullable ? c.sqlType - 1 : c.sqlType;
  return {
    name: c.name.trim().length > 0 ? c.name : `COL${index + 1}`,
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

/**
 * 行が尽きるまで fetch を繰り返す。
 *
 * `maxRows` を渡すとそこで打ち切り、**1 回ごとのブロッキング係数も残りに合わせる**
 * ——合わせないと「あと 1 行ほしい」ときにブロック 1 つぶん（既定 100 行）が丸ごと届く。
 * 実機での実測では 1 行を取るのに 2,956 バイト（ブロック 100）と 184 バイト（ブロック 1）
 * の差があった（`20260730-sql-fetch-limit` research F3）。
 */
async function* fetchAll(
  conn: DbConnection,
  format: ResultFormat,
  blockSize: number,
  maxRows?: number
): AsyncGenerator<Row, void, undefined> {
  let sent = 0;
  for (;;) {
    // **要求するのは「残り」まで**。上限が無ければブロック 1 つぶん
    const want = maxRows === undefined ? blockSize : Math.min(blockSize, maxRows - sent);
    if (want <= 0) return;
    const reply = await conn.request({
      reqId: DB_REQ.fetch,
      orsBitmap: ORS.sendReplyImmediately | ORS.resultData | ORS.sqlca,
      params: [
        identifier(DB_CP.cursorName, CURSOR_NAME),
        num(DB_CP.blockingFactor, want, 4)
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
      sent += data.rows.length;
      checkSqlca(reply, "fetch");
      // **要求した数より少なければ尽きている**（`blockSize` ではなく `want` と比べる
      // ——上限つきの最後の要求はブロックより小さいことがある）
      if (data.rows.length < want) return;
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
    sent += data.rows.length;
    checkSqlca(reply, "fetch");
    if (data.rows.length < want) return;
  }
}

/**
 * 行の中のロケーターを本体で置き換える。既定では呼ばれない。
 *
 * **export はテストの取っ手**（`index.ts` は公開しない）。`query()` 越しに失敗を踏ませるには
 * prepare / describe / fetch の応答を丸ごと偽装することになり、テストが失敗の再現ではなく
 * プロトコルの模写になる。`retrieveLob` が使う接続の口は `conn.request` 1 つだけなので、
 * ここを直接呼べば「request が reject する偽 conn」で足りる（spec D3）。
 */
export async function fillLobs(
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
          value: decodeLobBytes(got.bytes, got.ccsid)
        };
        // 打ち切ったときだけ理由を残す（取れたなら unavailable は付けない）
        if (got.truncated) filled.unavailable = "too-large";
        row[key] = filled;
      } catch (e) {
        // **warn で出す**。要求された取得が落ちたのに debug だと既定の sink で消え、
        // 失敗の理由がどこにも残らなかった（画面は「ログに理由が出る」と案内する）
        log.warn(`LOB ${value.locator} の取得に失敗: ${String(e)}`);
        // **`not-requested` に落とさない**——読み手が「では要求すればよい」と案内してしまう。
        // 既に要求した人に同じ操作を勧めることになる（spec D1）。
        // ロケーターと maxSize は spread で残す（取り直す手がかりを消さない）
        row[key] = { ...value, unavailable: "failed" };
      }
    }
  }
}

function isLobPlaceholder(v: DbValue): v is LobPlaceholder {
  return typeof v === "object" && v !== null && (v as LobPlaceholder).kind === "lob";
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
