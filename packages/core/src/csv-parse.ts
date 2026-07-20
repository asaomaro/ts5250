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
  /** この行に引用符付きのフィールドがあったか。**空行の判定に要る**（`""` は空行ではない） */
  let rowHadQuote = false;
  let i = 0;
  /** 物理的な行番号（1 始まり）。エラーの案内に使う。空行の読み飛ばしに影響されない */
  let physicalLine = 1;

  const endField = (): void => {
    record.push(field);
    field = "";
  };
  const endRecord = (): void => {
    endField();
    // 空行（1 列だけで中身が無い）は捨てる。ただし `""` と書かれた行は**残す**——
    // 書いた人は「空の値」を意図している。
    // ⚠ 判定は `endField()` の**後**なので、引用符の有無は行単位で覚えておく必要がある
    //   （フィールド単位のフラグは endField で消える）
    const empty = record.length === 1 && record[0] === "" && !rowHadQuote;
    if (!empty) records.push(record);
    record = [];
    rowHadQuote = false;
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
        // 閉じ引用符の直後は区切りか改行しか許さない。`"ab"cd` を黙って `abcd` にしない
        const next = src[i + 1];
        if (next !== undefined && next !== "," && next !== "\r" && next !== "\n") {
          throw new As400Error(
            "CONFIG_ERROR",
            `CSV の ${physicalLine} 行目: 閉じ引用符の後に文字が続いています`
          );
        }
        i++;
        continue;
      }
      if (ch === "\n") physicalLine++; // 引用符の中の改行も物理行としては進む
      field += ch;
      i++;
      continue;
    }

    if (ch === '"') {
      if (field === "") {
        quoted = true;
        rowHadQuote = true;
        i++;
        continue;
      }
      // `ab"cd` のような形。**黙って解釈を決めない**——どう直すべきか利用者に返す
      throw new As400Error(
        "CONFIG_ERROR",
        `CSV の ${physicalLine} 行目: 引用符は値の先頭にしか置けません`
      );
    }
    if (ch === ",") {
      endField();
      i++;
      continue;
    }
    if (ch === "\r" || ch === "\n") {
      endRecord();
      physicalLine++;
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
  if (field !== "" || rowHadQuote || record.length > 0) endRecord();

  if (records.length === 0) {
    throw new As400Error("CONFIG_ERROR", "CSV が空です");
  }
  const [header, ...rows] = records;
  return { header: header!, rows };
}
