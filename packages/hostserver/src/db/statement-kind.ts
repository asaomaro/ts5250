/**
 * SQL 文が「結果を返さない文」か（DML / DDL）を見分ける。
 *
 * **迷ったらクエリ扱い**にする（`false` を返す）。理由は非対称性:
 *
 * - 非クエリ経路へ誤ってクエリを送ると `SQLCODE -518 / 07003`（文が実行可能でない）で
 *   **明確に落ちる**（実機で実測。`20260730-sql-non-query-statements` research F5）
 * - クエリ経路へ誤って非クエリを送ると「この結果セットは取得できません」で落ちる
 *
 * どちらも落ちるだけだが、**知らない語を非クエリと決めつけると、実は SELECT だった文が
 * 実行できなくなる**——DDL/DML を取りこぼすより、知っているクエリ語だけを
 * クエリと認める形のほうが失敗が読みやすい。
 */

/** 結果を返す文の先頭語。**これ以外は非クエリとして扱う** */
const QUERY_HEADS = new Set(["SELECT", "VALUES", "WITH", "TABLE"]);

/**
 * 先頭のコメントと空白を取り除く。
 *
 * SQL 画面に貼られる文は先頭にコメントが付きやすい（`-- 顧客を消す` 等）。
 * 取り除かないと**すべて非クエリ**に見えてしまう。
 */
function stripLeading(sql: string): string {
  let s = sql;
  for (;;) {
    const before = s;
    s = s.replace(/^\s+/u, "");
    if (s.startsWith("--")) {
      const nl = s.indexOf("\n");
      s = nl < 0 ? "" : s.slice(nl + 1);
    } else if (s.startsWith("/*")) {
      const end = s.indexOf("*/");
      s = end < 0 ? "" : s.slice(end + 2);
    }
    if (s === before) return s;
  }
}

/**
 * 影響行数に意味がある文の先頭語。
 *
 * **SQLCA からは決められない**——DDL でも `updateCount` は 0 で返るので、
 * 「DDL の完了」と「0 行に影響した DML」が同じ値になる（research F3）。
 * 文の側から決めるしかない。
 */
const ROW_COUNT_HEADS = new Set(["INSERT", "UPDATE", "DELETE", "MERGE"]);

/**
 * 先頭のコメントと空白を取り除いた上で、先頭の 1 語を返す。
 *
 * **語境界で切る**（`SELECTX` を `SELECT` と読み違えないため）。
 * 括弧始まり（`(SELECT …) UNION …`）や語で始まらない文では `undefined`。
 */
function headOf(sql: string): string | undefined {
  const s = stripLeading(sql);
  return /^[A-Za-z]+/u.exec(s)?.[0]?.toUpperCase();
}

/**
 * その SQL は「結果を返さない文」か。
 *
 * 判定は**先頭の 1 語だけ**を見る（語境界つき）。
 * 括弧で始まる文（`(SELECT …) UNION (SELECT …)`）はクエリ。
 */
export function isNonQueryStatement(sql: string): boolean {
  const head = headOf(sql);
  // 空・コメントだけ・括弧始まりはここに来る。既存のクエリ経路に断らせる
  if (head === undefined) return false;
  return !QUERY_HEADS.has(head);
}

/**
 * その文の「影響行数」に意味があるか（DML か）。
 *
 * DDL に添えて「0 行に影響しました」と出さないための判定。
 * **`updateCount` の値では区別できない**（上の `ROW_COUNT_HEADS` の説明）。
 */
export function isRowCountStatement(sql: string): boolean {
  const head = headOf(sql);
  return head !== undefined && ROW_COUNT_HEADS.has(head);
}

/**
 * パラメータマーカー（`?`）を含むか。
 *
 * 非クエリ経路は `changeDescriptor` を送らない（マーカーが無い文だけを対象にする）ので、
 * **含む文は実行前に断る**。通してしまうとマーカーが埋まらないまま実行され、
 * 何が起きるか分からない（書き込みは取り消せない）。
 *
 * **文字列リテラルとコメントの中の `?` は数えない**（`SET S = '?'` や
 * `DELETE … -- 本当に消す?` は正しい文）。数えると**正しい文を実行前に断ってしまう**。
 */
export function hasParameterMarker(sql: string): boolean {
  let inQuote: "'" | '"' | undefined;
  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i];
    if (inQuote) {
      // 2 つ続きは埋め込まれた引用符（`''`）。閉じずに進む
      if (ch === inQuote && sql[i + 1] === inQuote) i += 1;
      else if (ch === inQuote) inQuote = undefined;
      continue;
    }
    // コメントは飛ばす。**引用符の判定より後に置く**——`'--'` は文字列であってコメントではない
    if (ch === "-" && sql[i + 1] === "-") {
      const nl = sql.indexOf("\n", i + 2);
      if (nl < 0) return false; // 以降すべてコメント
      i = nl;
      continue;
    }
    if (ch === "/" && sql[i + 1] === "*") {
      const end = sql.indexOf("*/", i + 2);
      if (end < 0) return false; // 閉じないブロックコメント
      i = end + 1;
      continue;
    }
    if (ch === "'" || ch === '"') inQuote = ch;
    else if (ch === "?") return true;
  }
  return false;
}
