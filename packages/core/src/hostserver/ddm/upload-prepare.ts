/**
 * 取り込みの**事前検査**。書く前に分かることを、ここで全部やる。
 *
 * DDM にはコミットメント制御が無く、**書いたレコードは巻き戻せない**。
 * よって「途中で符号化に失敗して半分書けた」状態を作らないことが仕様上の要求になる
 * （requirement「1 行も書かずに中止する」）。それを構造で保証するために、
 * **全行を符号化し終えてから**送信可能なレコード列を返す（design DD2）。
 *
 * この層は純関数で、`DbConnection` もソケットも触らない（design DD1）。
 * 取り込みロジックの大半がここに集まるので、実機なしで単体テストで固められる。
 */
import { codecForCcsid } from "../../codec/codec.js";
import { encodeInt, encodePacked, encodeZoned } from "./encode.js";
import {
  buildRecordLayout,
  isSupportedDataType,
  type ColumnLayoutInput,
  type RecordLayout
} from "./record-layout.js";
import type { DdmRecord } from "./ddm-connection.js";

/**
 * 拒否理由。**判別可能な型で返す**（design）——
 * 文字列メッセージだけにすると、UI が行番号や列名を取り出せず、
 * 「3 行目の TEST1」のような案内が組み立てられない。
 */
export type UploadRejection =
  /** 表にあるが CSV に無い（NULL を受け付けない列だけが問題になる） */
  | { kind: "column-missing"; columns: string[] }
  /** CSV にあるが表に無い */
  | { kind: "column-unknown"; columns: string[] }
  | { kind: "type-unsupported"; column: string; dataType: string }
  | { kind: "ccsid-unsupported"; column: string; ccsid: number }
  | { kind: "value-null"; row: number; column: string }
  | { kind: "value-too-long"; row: number; column: string; bytes: number; max: number }
  | { kind: "value-unencodable"; row: number; column: string; chars: string[]; ccsid: number }
  | { kind: "value-not-numeric"; row: number; column: string; value: string };

export type PrepareResult =
  | { ok: true; records: DdmRecord[]; layout: RecordLayout }
  | { ok: false; rejections: UploadRejection[]; truncated: boolean };

/** 拒否をいくつまで集めるか。**全部返すと 1 万行の CSV で応答が膨れる** */
const MAX_REJECTIONS = 100;

/**
 * 変換なし（バイナリ）を意味する CCSID。
 * **37 等で代替しない**——何を書くべきか決められないため、拒否して利用者に返す。
 */
const CCSID_NO_CONVERSION = 65535;

export interface PrepareUploadArgs {
  /** 表の列（宣言順＝ORDINAL_POSITION 順） */
  columns: readonly ColumnLayoutInput[];
  /** CSV のヘッダー */
  header: readonly string[];
  /** CSV のデータ行 */
  rows: readonly (readonly (string | null)[])[];
  /** 空文字を NULL として扱うか（既定 false＝空文字は空文字） */
  emptyAsNull?: boolean;
}

/** 列名の突き合わせは大文字・前後空白を無視する（CSV のヘッダーは人が書くため） */
const norm = (s: string): string => s.trim().toUpperCase();

export function prepareUpload(args: PrepareUploadArgs): PrepareResult {
  const { columns, header, rows, emptyAsNull = false } = args;
  const rejections: UploadRejection[] = [];

  // ---- 1. 構造の検査（列・型・CCSID）----
  // ここで落ちるものは行を見るまでもないので、**行の検査より先に**片付ける。
  const unsupported = columns.filter((c) => !isSupportedDataType(c.dataType));
  for (const c of unsupported) {
    rejections.push({ kind: "type-unsupported", column: c.name, dataType: c.dataType.trim() });
  }

  for (const c of columns) {
    if (!isSupportedDataType(c.dataType)) continue;
    if (c.dataType.trim().toUpperCase() !== "CHAR") continue;
    const ccsid = c.ccsid ?? 37;
    if (ccsid === CCSID_NO_CONVERSION || !codecExists(ccsid)) {
      rejections.push({ kind: "ccsid-unsupported", column: c.name, ccsid });
    }
  }

  const headerNorm = header.map(norm);
  const colByHeaderIndex = new Map<number, ColumnLayoutInput>();
  const matchedColumns = new Set<string>();
  const unknown: string[] = [];
  for (let i = 0; i < headerNorm.length; i++) {
    const col = columns.find((c) => norm(c.name) === headerNorm[i]);
    if (col) {
      colByHeaderIndex.set(i, col);
      matchedColumns.add(norm(col.name));
    } else {
      unknown.push(header[i]!.trim());
    }
  }
  if (unknown.length > 0) rejections.push({ kind: "column-unknown", columns: unknown });

  // CSV に無い列は NULL 扱いになる。**NULL を受け付けない列だけ**が問題
  const missing = columns
    .filter((c) => !c.nullable && !matchedColumns.has(norm(c.name)))
    .map((c) => c.name);
  if (missing.length > 0) rejections.push({ kind: "column-missing", columns: missing });

  // 構造が崩れていたら行は見ない。**列が対応づかない状態で行を検査しても意味のある指摘にならない**
  if (rejections.length > 0) {
    return {
      ok: false,
      rejections: rejections.slice(0, MAX_REJECTIONS),
      truncated: rejections.length > MAX_REJECTIONS
    };
  }

  // ---- 2. 全行を符号化する ----
  const layout = buildRecordLayout(columns);
  const records: DdmRecord[] = [];

  // CSV の列位置 → レコードのフィールド位置。**行ごとに引き直さない**（行数ぶん繰り返されるため）
  const fieldIndexByHeaderIndex = new Map<number, number>();
  for (const [i, col] of colByHeaderIndex) {
    const at = layout.fields.findIndex((f) => norm(f.name) === norm(col.name));
    if (at >= 0) fieldIndexByHeaderIndex.set(i, at);
  }

  for (let r = 0; r < rows.length; r++) {
    const rowNo = r + 1; // **CSV のデータ行番号（ヘッダーを除く 1 始まり）**
    const row = rows[r]!;
    // 列の宣言順に値を並べ直す（CSV の列順は表と無関係でよい）。
    // 対応づかない列は NULL のまま＝「CSV に無い列」は NULL 扱い
    const values: (string | null)[] = layout.fields.map(() => null);
    for (const [i, at] of fieldIndexByHeaderIndex) {
      const raw = i < row.length ? row[i]! : null;
      values[at] = raw === null || (emptyAsNull && raw === "") ? null : raw;
    }

    const encoded = encodeRow(layout, values, rowNo, rejections);
    if (encoded) records.push(encoded);
    if (rejections.length >= MAX_REJECTIONS) {
      // **まだ見ていない行が残っているときだけ truncated**。ちょうど上限で終わった場合、
      // 切り捨てたものは無いのに「先頭 100 件まで」と案内するのは嘘になる
      return {
        ok: false,
        rejections: rejections.slice(0, MAX_REJECTIONS),
        truncated: rejections.length > MAX_REJECTIONS || r < rows.length - 1
      };
    }
  }

  if (rejections.length > 0) {
    return { ok: false, rejections, truncated: false };
  }
  return { ok: true, records, layout };
}

/** 1 行を符号化する。失敗は例外にせず `rejections` に積む（**まとめて返すため**） */
function encodeRow(
  layout: RecordLayout,
  values: readonly (string | null)[],
  rowNo: number,
  rejections: UploadRejection[]
): DdmRecord | undefined {
  const out = new Uint8Array(layout.recordLength).fill(0x40);
  const nulls: boolean[] = new Array(layout.fields.length).fill(false);
  let failed = false;

  for (let i = 0; i < layout.fields.length; i++) {
    const f = layout.fields[i]!;
    const v = values[i]!;

    if (v === null) {
      if (!f.nullable) {
        rejections.push({ kind: "value-null", row: rowNo, column: f.name });
        failed = true;
        continue;
      }
      out.set(new Uint8Array(f.size).fill(f.kind === "char" ? 0x40 : 0x00), f.offset);
      nulls[i] = true;
      continue;
    }

    if (f.kind === "char") {
      const ccsid = f.ccsid ?? 37;
      const codec = codecForCcsid(ccsid);
      const { bytes, substituted } = codec.encode(v);
      if (substituted === 0 && bytes.length <= f.size) {
        // 成功経路では符号化を 1 回で済ませる（encodeChar に渡すと同じ変換をもう一度走らせる）
        const padded = new Uint8Array(f.size).fill(0x40);
        padded.set(bytes, 0);
        out.set(padded, f.offset);
        continue;
      }
      if (substituted > 0) {
        // どの文字が書けないかを返す。**1 文字ずつ試す**——コーデックは件数しか返さないため。
        // 失敗経路でしか通らないので、この総当たりの費用は問題にならない
        const chars = [...v].filter((ch) => codec.encode(ch).substituted > 0);
        rejections.push({ kind: "value-unencodable", row: rowNo, column: f.name, chars, ccsid });
        failed = true;
        continue;
      }
      if (bytes.length > f.size) {
        rejections.push({
          kind: "value-too-long",
          row: rowNo,
          column: f.name,
          bytes: bytes.length,
          max: f.size
        });
        failed = true;
        continue;
      }
      continue;
    }

    // 数値。**変換できるかは試すまで分からない**ので、例外を捕まえて拒否に変える
    try {
      const bytes =
        f.kind === "packed"
          ? encodePacked(v, f.precision, f.scale)
          : f.kind === "zoned"
            ? encodeZoned(v, f.precision, f.scale)
            : encodeInt(v, f.size as 2 | 4 | 8);
      out.set(bytes, f.offset);
    } catch {
      rejections.push({ kind: "value-not-numeric", row: rowNo, column: f.name, value: v });
      failed = true;
    }
  }

  return failed ? undefined : { data: out, nulls };
}

/** その CCSID のコーデックがあるか（`codecForCcsid` は無いと例外を投げる） */
function codecExists(ccsid: number): boolean {
  try {
    codecForCcsid(ccsid);
    return true;
  } catch {
    return false;
  }
}
