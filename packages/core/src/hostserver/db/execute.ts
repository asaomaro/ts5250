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
 */
import { As400Error } from "../../errors.js";
import { childLog } from "../../log.js";
import { codecForCcsid } from "@as400web/ebcdic";
import { findParam } from "../datastream.js";
import { DB_CP, DB_REQ, ORS } from "./db-datastream.js";
import type { DbConnection, DbReply } from "./db-connection.js";
import { parseSqlca } from "./db-reply.js";
import { SqlError } from "./query.js";
import { hasParameterMarker, isRowCountStatement } from "./statement-kind.js";

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
}

/**
 * 結果を返さない文を実行する。
 *
 * @throws `SqlError` SQLCODE が負のとき（構文誤り・存在しない表・経路違い `-518`）
 * @throws `As400Error("CONFIG_ERROR")` パラメータマーカー（`?`）を含むとき
 */
export async function executeStatement(conn: DbConnection, sql: string): Promise<ExecuteResult> {
  if (hasParameterMarker(sql)) {
    // `CONFIG_ERROR` を使うのは「**指定の不備**で、直す先はこちら側」だから（`errors.ts` の定義。
    // HTTP 400）。`SQL_ERROR` はホストが判定した誤りに使う——ここはホストへ行く前に断っている
    throw new As400Error(
      "CONFIG_ERROR",
      "パラメータマーカー（?）を含む文はこの経路では実行できません（値を埋めた文を送ってください）"
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

    // 2) 実行。**マーカーデータは載せない**（マーカーが無い文だけを扱う。research F2）
    const exec = await conn.request({
      reqId: DB_REQ.execute,
      // **診断ビットを常に立てる**。立てないと失敗が空の SQLCA だけになり原因が分からない
      orsBitmap: ORS.sendReplyImmediately | ORS.sqlca | ORS.messageId | ORS.firstLevelText,
      params: [
        identifier(DB_CP.prepareStatementName, STATEMENT_NAME),
        num(DB_CP.sqlStatementType, STATEMENT_TYPE_OTHER, 2)
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
    if (ca.sqlCode > 0) {
      result.warning = { sqlCode: ca.sqlCode, sqlState: ca.sqlState };
      log.debug(`statement succeeded with warning: SQLCODE=${ca.sqlCode} SQLSTATE=${ca.sqlState}`);
    }
    return result;
  } finally {
    release();
  }
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
    throw new As400Error("PROTOCOL_ERROR", `${what}（応答に SQLCA がなく成否を判定できません）`);
  }
  if (ca.sqlCode < 0) {
    throw new SqlError(ca.sqlCode, ca.sqlState, `${what}: SQLCODE=${ca.sqlCode} SQLSTATE=${ca.sqlState}`);
  }
  return ca;
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
