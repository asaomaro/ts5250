/**
 * SQL テキストを `;` で複数の文に分ける。
 *
 * **本体は「区切りに見えるが区切りでないもの」を外すこと**——
 * 文字列・引用符付き識別子・コメントの中の `;` を区切りにすると、
 * `WHERE NAME = 'A;B'` が壊れた 2 文になって実行できない。
 *
 * DB2 for i の字句規則:
 *
 * - 文字列 `'…'` の中の `'` は `''` で書く（`'It''s'`）
 * - 引用符付き識別子 `"…"` の中の `"` は `""` で書く（`"MY;TABLE"` は正当な名前）
 * - 行コメント `--` は行末まで
 * - ブロックコメント `/* … *​/` は閉じるまで。**入れ子にしない**
 *
 * 閉じていない文字列・コメントは、**そこから末尾までを 1 つの文**として返す。
 * ここで構文を判定して弾かない——ホストの構文エラーの方が利用者にとって情報が多い。
 *
 * Node API に依存しないピュアロジック（`browser.ts` から UI が使う）。
 */

export interface SqlStatement {
  /** 実行する文（前後の空白を落とし、区切りの `;` は含まない） */
  sql: string;
  /** 元のテキストでの開始位置（0 起点）。エラー箇所の案内に使える */
  offset: number;
}

/** 文の中身があるか（空白・コメントだけの断片は実行しない） */
function hasContent(text: string): boolean {
  return stripComments(text).trim().length > 0;
}

/**
 * コメントを空白に置き換える（中身の有無を判定するためだけに使う）。
 * **文字列の中は触らない**——`'-- not a comment'` はれっきとした値。
 */
function stripComments(text: string): string {
  let out = "";
  let i = 0;
  while (i < text.length) {
    const c = text[i] as string;
    const next = text[i + 1];
    if (c === "'" || c === '"') {
      const end = skipQuoted(text, i, c);
      out += text.slice(i, end);
      i = end;
      continue;
    }
    if (c === "-" && next === "-") {
      const nl = text.indexOf("\n", i);
      i = nl < 0 ? text.length : nl;
      continue;
    }
    if (c === "/" && next === "*") {
      const end = text.indexOf("*/", i + 2);
      i = end < 0 ? text.length : end + 2;
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

/**
 * `start` の引用符から始まる範囲の終端（閉じ引用符の次）を返す。
 * 閉じていなければテキスト末尾。`''` / `""` は**閉じずに続く**（エスケープ）。
 */
function skipQuoted(text: string, start: number, quote: string): number {
  let i = start + 1;
  while (i < text.length) {
    if (text[i] === quote) {
      if (text[i + 1] === quote) {
        i += 2; // エスケープされた引用符。まだ中
        continue;
      }
      return i + 1;
    }
    i++;
  }
  return text.length;
}

/**
 * `;` で分割する。区切りは**文字列・識別子・コメントの外にあるものだけ**。
 * 空の文（`;;`・末尾の `;`・コメントだけ）は返さない。
 */
export function splitSqlStatements(text: string): SqlStatement[] {
  const out: SqlStatement[] = [];
  let start = 0;
  let i = 0;

  const push = (end: number): void => {
    const raw = text.slice(start, end);
    if (!hasContent(raw)) return;
    // 前の空白を落とした分だけ offset を進める（エラー案内で位置がずれないように）
    const lead = raw.length - raw.trimStart().length;
    out.push({ sql: raw.trim(), offset: start + lead });
  };

  while (i < text.length) {
    const c = text[i] as string;
    const next = text[i + 1];
    if (c === "'" || c === '"') {
      i = skipQuoted(text, i, c);
      continue;
    }
    if (c === "-" && next === "-") {
      const nl = text.indexOf("\n", i);
      i = nl < 0 ? text.length : nl;
      continue;
    }
    if (c === "/" && next === "*") {
      const end = text.indexOf("*/", i + 2);
      i = end < 0 ? text.length : end + 2;
      continue;
    }
    if (c === ";") {
      push(i);
      start = i + 1;
      i++;
      continue;
    }
    i++;
  }
  push(text.length);
  return out;
}

/**
 * タブの見出しなどに使う短い要約。改行と連続する空白を 1 つに潰して切り詰める。
 * **文そのものを見せる**のが目的なので、整形や解析はしない。
 */
export function summarizeSql(sql: string, maxLength = 30): string {
  // **先頭のコメントは飛ばす**。見出しに「-- 2 つ目」とだけ出ても、
  // どの文の結果なのか分からない（実機の画面で気づいた）
  let i = 0;
  for (;;) {
    const rest = sql.slice(i);
    const trimmed = rest.trimStart();
    i += rest.length - trimmed.length;
    if (trimmed.startsWith("--")) {
      const nl = sql.indexOf("\n", i);
      if (nl < 0) break;
      i = nl + 1;
      continue;
    }
    if (trimmed.startsWith("/*")) {
      const end = sql.indexOf("*/", i + 2);
      if (end < 0) break;
      i = end + 2;
      continue;
    }
    break;
  }
  const flat = sql.slice(i).replace(/\s+/g, " ").trim() || sql.replace(/\s+/g, " ").trim();
  return flat.length > maxLength ? `${flat.slice(0, maxLength - 1)}…` : flat;
}
