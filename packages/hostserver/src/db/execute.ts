/**
 * 結果を返さない SQL 文（DML / DDL）の実行。
 *
 * ## なぜ `executeImmediate` を使わないか
 *
 * `executeImmediate`(0x1806) と `prepare`(0x1800) は実機で `rcClass=2 / -215` に拒否される
 * （`20260723-sql-multi-statement` research F2）。一方
 * **`prepareAndDescribe`(0x1803) → `execute`(0x1805) は DML も DDL も通る**
 * （実機で実測。`20260730-sql-non-query-statements` research F1）。
 * `insert.ts` が既に使っている道で、そこから `changeDescriptor` を落とせばよい
 * ——マーカーが無い文ではマーカー形式が**空（0 バイト）で返る**ので登録するものが無い（同 F2）。
 *
 * ## ⚠ 接続の占有
 *
 * `insert.ts` と同じ性質: この関数を呼んでいる間、その接続に**他の SQL を流してはならない**。
 * 同じ RPB に別の文が準備されるとこちらの文が失われる。文名は `insert.ts` と**別にしてある**
 * （あちらは `ASUPLOAD`）。
 *
 * ## ⚠ 取り消せない
 *
 * コミットメント制御は使っていない。**成功と確認できたときだけ成功として扱う**
 * ——SQLCA が読めない応答は失敗とする（`insert.ts` と同じ安全側の判断）。
 *
 * ## `CALL` の `?`（出力パラメーター）
 *
 * `CALL P(1, ?)` の `?` は**値を書く場所ではなく、結果を受け取る場所**である。
 * 断ってしまうと手続きの OUT を画面から見る手段が無くなるので、CALL に限って通す
 * （`insert.ts` と同じ `changeDescriptor` → `execute` の道を使い、
 * 実行後の応答に載る値を読む。実機で実測）。
 *
 * **入力としては NULL を送る。** 位置ごとに IN か OUT かはこちらには分からず、
 * 値を書く UI も無い。入力に値が要る位置には値をそのまま書いてもらう。
 */
import { As400Error } from "@ts5250/base";
import { childLog } from "@ts5250/base";
import { codecForCcsid } from "@ts5250/ebcdic";
import { findParam } from "../datastream.js";
import { DB_CP, DB_REQ, ORS } from "./db-datastream.js";
import type { DbConnection, DbReply } from "./db-connection.js";
import { parseSqlca, resultSetCountOf } from "./db-reply.js";
import { parseExtendedResultData } from "./db-reply-ext.js";
import { parseMarkerFormat, type MarkerFormat } from "./marker-format.js";
import { encodeMarkerRow, buildMarkerData } from "./marker-encode.js";
import { decodeRow, type ColumnMeta, type DbValue } from "./db-decode.js";
import { typeName, jsTypeOf } from "./db-types.js";
import { SqlError, readProcedureResultSet, type LobOptions } from "./query.js";
import { hasParameterMarker, isCallStatement, isRowCountStatement } from "./statement-kind.js";

const log = childLog({ component: "hostserver-sql-execute" });

/** SQL 文テキストの CCSID（UTF-16BE）。日本語もこのまま届く */
const SQL_TEXT_CCSID = 13488;
/** 文名・カーソル名の CCSID */
const IDENTIFIER_CCSID = 37;
/**
 * 文の種別。**1 で DML も DDL も通った**（research F4。0 でも通ったが、
 * `insert.ts` が 1 で動いているので揃える）。
 */
const STATEMENT_TYPE_OTHER = 1;
/** この経路が使う文名。`insert.ts` の `ASUPLOAD` とは**別にする** */
const STATEMENT_NAME = "ASEXEC";
/**
 * 手続きの結果セットを受けるカーソル名。
 * `query.ts` の `C1` とは**別にする**——同じ接続で踏み合わないように。
 */
const CURSOR_NAME = "ASEXECC";
/** マーカー・ディスクリプタのハンドル（RPB ハンドルとは別の欄） */
const DESCRIPTOR_HANDLE = 1;
/**
 * 手続きが結果セットを返したときの SQLCODE。
 * **失敗ではない**——「使える結果セットが N 個ある」という知らせ。
 */
const SQLCODE_RESULT_SETS = 466;
/** 結果セットから読む既定の行数（画面が指定しなければこれ） */
const DEFAULT_RESULT_LIMIT = 200;

/** 結果を返さない文の実行結果 */
export interface ExecuteResult {
  /** 影響した行数。行の概念が無い文（DDL）では 0 */
  updateCount: number;
  /**
   * 影響行数に意味があるか。
   * **DDL の「0 行」と DML の「0 行」を呼び出し側が区別できる**ようにするために添える。
   */
  hasRowCount: boolean;
  /**
   * 警告（SQLCODE が正）。**成功だが伝えるべきこと**。
   * 実ライブラリーへの `CREATE TABLE` は `7905 / 01567` で返る（research F6）——
   * 捨てると「作られたのに何も言われない」になる。
   */
  warning?: { sqlCode: number; sqlState: string };
  /**
   * `?` に対応する値（`CALL` の出力パラメーター）。マーカーが無い文では付かない。
   * 並びは文中の `?` と同じ順。**入力として送った位置には NULL が返る**。
   */
  outputs?: DbValue[];
  /**
   * 手続きが返した結果セット（`CALL` で `SQLCODE +466` のとき）。
   *
   * **取れるのは 1 個目だけ。** 2 個目を開こうとすると `SQLCODE -517`
   * （選択ステートメントではない）で断られる。実機で 10 通り試して確かめた——
   * カーソル名を変える／取り切る前に開く／閉じてから開き直す／手続き側の名前（`C1`・`C2`）で開く／
   * `describe` を挟む／`openDescribeFetch` を使う／文名を分けて 2 度 `execute` する／
   * 実行し直す／文の種別 0〜6 を総当たり／ORS を全ビット立てる。**どれも 1 個目が返る**。
   *
   * SQL の側には道がある（`ASSOCIATE RESULT SET LOCATORS`）が、読んだ行をクライアントへ
   * 返すには**列の形を知った器**が要るので汎用にできない。雛形を
   * `scripts/build-sqldemo.mjs`（`SQLDEMOPICK`）に置いてある。
   *
   * いくつあったかは `resultSets` で伝え、黙って捨てない。
   */
  resultSet?: { columns: ColumnMeta[]; rows: Record<string, DbValue>[]; truncated: boolean };
  /** 手続きが返した結果セットの数（ホストの申告）。読めなければ付かない */
  resultSets?: number;
}

/** `executeStatement` の任意設定 */
export interface ExecuteOptions {
  /** 結果セットから読む行数の上限（既定 200） */
  resultLimit?: number;
  /** 結果セットの LOB の取り方（指定しなければロケーターのまま） */
  lob?: LobOptions;
}

/**
 * 結果を返さない文を実行する。
 *
 * @throws `SqlError` SQLCODE が負のとき（構文誤り・存在しない表・経路違い `-518`）
 * @throws `As400Error("CONFIG_ERROR")` `CALL` 以外でパラメータマーカー（`?`）を含むとき
 */
export async function executeStatement(
  conn: DbConnection,
  sql: string,
  options: ExecuteOptions = {}
): Promise<ExecuteResult> {
  const markersAllowed = isCallStatement(sql);
  if (hasParameterMarker(sql) && !markersAllowed) {
    // `CONFIG_ERROR` を使うのは「**指定の不備**で、直す先はこちら側」だから（`errors.ts` の定義。
    // HTTP 400）。`SQL_ERROR` はホストが判定した誤りに使う——ここはホストへ行く前に断っている
    throw new As400Error(
      "CONFIG_ERROR",
      "パラメータマーカー（?）を含む文はこの経路では実行できません（値を埋めた文を送ってください）。" +
        "? を使えるのは CALL の出力パラメーターだけです"
    );
  }
  const release = conn.acquire();
  try {
    // 1) 準備。**構文誤り・存在しない表はここで分かる**（research F5）
    const prep = await conn.request({
      reqId: DB_REQ.prepareAndDescribe,
      orsBitmap:
        ORS.sendReplyImmediately | ORS.sqlca | ORS.parameterMarkerFormat | ORS.messageId | ORS.firstLevelText,
      params: [
        identifier(DB_CP.prepareStatementName, STATEMENT_NAME),
        sqlText(DB_CP.sqlStatementText, sql),
        num(DB_CP.sqlStatementType, STATEMENT_TYPE_OTHER, 2)
      ],
      allowTemplateError: true
    });
    checkSqlca(prep, "文を準備できませんでした");

    // **マーカーが要るかはサーバーの申告で決める**（文の `?` を数えない）。
    // 形式は長さ 0 で返ることがあり（マーカー無し）、そのときは登録するものが無い
    const rawFormat = markersAllowed ? findParam(prep, DB_CP.parameterMarkerFormat) : undefined;
    const format =
      rawFormat && rawFormat.length > 0 ? parseMarkerFormat(rawFormat) : undefined;
    const withMarkers = format !== undefined && format.fields.length > 0;
    if (withMarkers) await changeDescriptor(conn, format);

    // 2) 実行。マーカーが無ければデータは載せない（research F2）
    const exec = await conn.request({
      reqId: DB_REQ.execute,
      // **診断ビットを常に立てる**。立てないと失敗が空の SQLCA だけになり原因が分からない。
      // マーカーがあるときは出力値が要るので結果データも要求する
      orsBitmap:
        ORS.sendReplyImmediately |
        ORS.sqlca |
        ORS.messageId |
        ORS.firstLevelText |
        (withMarkers ? ORS.resultData : 0),
      ...(withMarkers ? { parameterMarkerHandle: DESCRIPTOR_HANDLE } : {}),
      params: [
        // **`CALL` にはカーソル名を添える。** 添えないと、結果セットを返す手続きは
        // `rcClass=2 / -403` で断られ、SQLCA すら返らない（実機で実測）。
        // 添えると `SQLCODE +466`（結果セットが N 個ある）になり、このカーソルから読める
        ...(markersAllowed ? [identifier(DB_CP.cursorName, CURSOR_NAME)] : []),
        identifier(DB_CP.prepareStatementName, STATEMENT_NAME),
        num(DB_CP.sqlStatementType, STATEMENT_TYPE_OTHER, 2),
        ...(withMarkers
          ? [{ cp: DB_CP.extendedParameterMarkerData, value: nullMarkerData(format) }]
          : [])
      ],
      allowTemplateError: true
    });
    const ca = checkSqlca(exec, "文を実行できませんでした");

    const result: ExecuteResult = {
      updateCount: Math.max(0, ca.updateCount),
      // **文の側で決める。** SQLCA は DDL でも `updateCount: 0` を返すので、
      // 「DDL の完了」と「0 行に影響した DML」を件数からは区別できない（research F3）
      hasRowCount: isRowCountStatement(sql)
    };
    if (ca.sqlCode > 0 && ca.sqlCode !== SQLCODE_RESULT_SETS) {
      result.warning = { sqlCode: ca.sqlCode, sqlState: ca.sqlState };
      log.debug(`statement succeeded with warning: SQLCODE=${ca.sqlCode} SQLSTATE=${ca.sqlState}`);
    }
    if (withMarkers) {
      const outputs = readOutputs(exec, format);
      if (outputs) result.outputs = outputs;
    }
    // **+466 は警告ではなく「結果セットがある」という知らせ。** 続けて読む
    if (ca.sqlCode === SQLCODE_RESULT_SETS) {
      const raw = findParam(exec, DB_CP.sqlca);
      const count = raw ? resultSetCountOf(raw) : undefined;
      if (count !== undefined) result.resultSets = count;
      result.resultSet = await readProcedureResultSet(conn, {
        statement: STATEMENT_NAME,
        cursor: CURSOR_NAME,
        limit: options.resultLimit ?? DEFAULT_RESULT_LIMIT,
        ...(options.lob ? { lob: options.lob } : {})
      });
    }
    return result;
  } finally {
    release();
  }
}

/** マーカー形式を登録する（`insert.ts` と同じ手順・同じ理由で SQLCA も要求する） */
async function changeDescriptor(conn: DbConnection, format: MarkerFormat): Promise<void> {
  const reply = await conn.request({
    reqId: DB_REQ.changeDescriptor,
    orsBitmap: ORS.sendReplyImmediately | ORS.sqlca | ORS.messageId | ORS.firstLevelText,
    // **RPB ハンドルではなくマーカーのハンドル欄**（template のオフセット 16）
    parameterMarkerHandle: DESCRIPTOR_HANDLE,
    params: [{ cp: DB_CP.extendedParameterMarkerFormat, value: format.raw }],
    allowTemplateError: true
  });
  // **ここは SQLCA を求めない。** 成功しても SQLCA を返さない（実測では
  // `rcClass=0` ＋「PWS0002 機能が正常に完了した。」だけ）。求めると必ず失敗する。
  // 書き込みではなく形式の登録なので、template の成否で足りる
  const raw = findParam(reply, DB_CP.sqlca);
  const ca = raw ? parseSqlca(raw) : undefined;
  if (reply.dbTemplate.rcClass !== 0 || (ca !== undefined && ca.sqlCode < 0)) {
    throw new As400Error(
      "SQL_ERROR",
      `パラメータマーカーの形式を登録できませんでした${hostDetail(reply)}`
    );
  }
}

/** すべて NULL の 1 行。**入力値は持たない**（上の docstring の判断） */
function nullMarkerData(format: MarkerFormat): Uint8Array {
  const row = encodeMarkerRow(format, format.fields.map(() => null));
  return buildMarkerData(format, [row]);
}

/**
 * 実行後の応答から `?` の値を読む。
 *
 * マーカーの形式は**結果列と同じ並び**なので、そのまま列として復号できる。
 * 応答に結果データが無ければ `undefined`（出力を持たない手続きはこれになる）。
 */
function readOutputs(reply: DbReply, format: MarkerFormat): DbValue[] | undefined {
  const raw = findParam(reply, DB_CP.extendedResultData) ?? findParam(reply, DB_CP.resultData);
  if (!raw || raw.length === 0) return undefined;
  try {
    const { rows, nulls } = parseExtendedResultData(raw);
    const row = rows[0];
    if (!row) return undefined;
    const columns = format.fields.map(markerColumn);
    const decoded = decodeRow(row, columns, nulls[0] ?? []);
    return columns.map((c) => decoded[c.name] ?? null);
  } catch (e) {
    // **出力が読めなくても実行そのものは成功している。** ここで投げると
    // 「手続きは動いたのに失敗と表示される」ことになる
    log.debug(`could not decode output parameters: ${String(e)}`);
    return undefined;
  }
}

/** マーカー 1 つを列として見る（復号は列と同じ規則） */
function markerColumn(f: MarkerFormat["fields"][number], i: number): ColumnMeta {
  // 型コードは NULL 可なら +1 されている（結果列と同じ規則）
  const nullable = f.sqlType % 2 === 1;
  const type = nullable ? f.sqlType - 1 : f.sqlType;
  return {
    name: `?${i + 1}`,
    type,
    typeName: typeName(type),
    offset: f.offset,
    length: f.length,
    scale: f.scale,
    precision: f.precision,
    ccsid: f.ccsid,
    nullable,
    jsType: jsTypeOf(type)
  };
}

/**
 * 応答の SQLCA を検査する。**成功と言い切れるときだけ通す**。
 *
 * - `SQLCODE < 0` → 失敗（`SqlError`）
 * - `SQLCODE >= 0` → 成功（正は警告つき）
 * - **SQLCA が読めない → 失敗**。書き込みは取り消せないので、判定材料が無いときは
 *   成功と見なさない（`insert.ts` の `requireSqlca` と同じ）
 *
 * **`reply.rcClass` は見ない**——`Reply` にその欄は無く（`dbTemplate` 側）、参照すると
 * 常に `undefined` ＝ 常に失敗扱いになる（research F7 で実際に踏んだ）。
 */
function checkSqlca(reply: DbReply, what: string): { sqlCode: number; sqlState: string; updateCount: number } {
  const raw = findParam(reply, DB_CP.sqlca);
  const ca = raw ? parseSqlca(raw) : undefined;
  if (!ca) {
    // **ホストが言ったことを捨てない。** SQLCA が空になる失敗は実在する
    // （結果セットを返す手続きの `CALL` は `rcClass=2 / -403` で SQLCA が 0 バイト。
    // 実機で実測）。理由を落とすと「判定できません」しか出ず、原因に辿り着けない
    throw new As400Error(
      "PROTOCOL_ERROR",
      `${what}（応答に SQLCA がなく成否を判定できません）${hostDetail(reply)}`
    );
  }
  if (ca.sqlCode < 0) {
    throw new SqlError(
      ca.sqlCode,
      ca.sqlState,
      `${what}: SQLCODE=${ca.sqlCode} SQLSTATE=${ca.sqlState}${hostDetail(reply)}`
    );
  }
  return ca;
}

/**
 * ホストが添えた診断（`rcClass` とメッセージ）を読める形にする。
 *
 * **メッセージ本文の CCSID は本文の先頭 2 バイトに載っている**——固定で 37 と読むと
 * 日本語のメッセージが化けて、結局読めない（実測で「文字変換中にエラーが起こった。」が
 * 判読不能になった）。
 */
function hostDetail(reply: DbReply): string {
  const parts: string[] = [];
  const t = reply.dbTemplate;
  if (t.rcClass !== 0) parts.push(`rcClass=${t.rcClass} rc=${t.rcClassReturnCode}`);
  const id = findParam(reply, DB_CP.messageId);
  // メッセージ ID は CCSID(2) ＋ 本文（長さ欄を持たない）
  if (id && id.length > 2) parts.push(decodeHostText(id, 2));
  const text = findParam(reply, DB_CP.messageText);
  // 本文は CCSID(2) ＋ 長さ(2) ＋ 本体
  if (text && text.length > 4) parts.push(decodeHostText(text, 4));
  return parts.length > 0 ? ` [${parts.join(" ")}]` : "";
}

/** 先頭 2 バイトの CCSID で復号する。読めない CCSID は捨てる（診断は付加情報） */
function decodeHostText(value: Uint8Array, at: number): string {
  try {
    const ccsid = (value[0]! << 8) | value[1]!;
    return codecForCcsid(ccsid).decode(value.subarray(at)).trim();
  } catch {
    return "";
  }
}

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
