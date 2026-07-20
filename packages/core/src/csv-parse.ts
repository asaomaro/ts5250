/**
 * CSV テキストを行に分解する（RFC 4180）。
 *
 * **生成側（`web-ui/src/csv.ts`）と対になる解析側**だが、置き場所はここ（core）にする——
 * web-ui（プレビューと行番号の提示）と MCP ツール（CSV 文字列の受け口）の
 * 両方が使うため。パーサーが 2 つあると、行番号の数え方がずれる（spec D4）。
 *
 * 純関数。ファイル読み込みは呼び出し側の責務（core は Node API に依存しない）。
 */
import { As400Error } from "./errors.js";

export interface CsvParseResult {
  /** 先頭行。列名として使う */
  header: string[];
  /** データ行。**ヘッダーを含まない**ので、添字 + 1 が利用者に見せる行番号になる */
  rows: string[][];
}

/** UTF-8 の BOM。Excel が書き出す CSV に付く */
const BOM = "﻿";

/**
 * 解析する。
 *
 * - 引用符の中では改行もカンマも文字として扱う。
 * - 引用符の中の `""` は `"` 1 つ。
 * - 行末は CRLF / LF / CR のいずれでもよい。
 * - **末尾の改行は行を増やさない**（`a\n` は 1 行）。
 * - **空行は読み飛ばす**（Excel の書き出しに混じるため）。ただし引用符の中の空行は残す。
 */
export function parseCsv(text: string): CsvParseResult {
  const src = text.startsWith(BOM) ? text.slice(BOM.length) : text;
  const records: string[][] = [];
  let field = "";
  let record: string[] = [];
  let quoted = false;
  let fieldWasQuoted = false;
  let i = 0;

  const endField = (): void => {
    record.push(field);
    field = "";
    fieldWasQuoted = false;
  };
  const endRecord = (): void => {
    endField();
    // 空行（1 列だけで中身が無い）は捨てる。引用符付きの空文字は**残す**——
    // `""` と書いた人は「空の値」を意図しているため
    const empty = record.length === 1 && record[0] === "";
    if (!empty) records.push(record);
    record = [];
  };

  while (i < src.length) {
    const ch = src[i]!;

    if (quoted) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        quoted = false;
        i++;
        continue;
      }
      field += ch;
      i++;
      continue;
    }

    if (ch === '"') {
      if (field !== "") {
        // `ab"cd` のような形。**黙って解釈を決めない**——どう直すべきか利用者に返す
        throw new As400Error(
          "CONFIG_ERROR",
          `CSV の ${records.length + 1} 行目: 引用符は値の先頭にしか置けません`
        );
      }
      quoted = true;
      fieldWasQuoted = true;
      i++;
      continue;
    }
    if (ch === ",") {
      endField();
      i++;
      continue;
    }
    if (ch === "\r" || ch === "\n") {
      endRecord();
      // CRLF は 1 つの改行として扱う
      i += ch === "\r" && src[i + 1] === "\n" ? 2 : 1;
      continue;
    }
    field += ch;
    i++;
  }

  if (quoted) {
    throw new As400Error("CONFIG_ERROR", "CSV の引用符が閉じていません");
  }
  // 末尾に改行が無ければ最後の行がまだ確定していない。
  // 改行で終わっていれば field も record も空なので、この呼び出しは何も足さない
  if (field !== "" || fieldWasQuoted || record.length > 0) endRecord();

  if (records.length === 0) {
    throw new As400Error("CONFIG_ERROR", "CSV が空です");
  }
  const [header, ...rows] = records;
  return { header: header!, rows };
}
