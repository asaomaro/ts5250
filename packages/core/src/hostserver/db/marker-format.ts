/**
 * パラメータマーカーの形式（サーバーが `prepareAndDescribe` の応答で返す `0x3813`）。
 *
 * **こちらが型を計算しない**のが要点である。挿入先の列がどんな型で、
 * マーカーデータの中で何バイト占めるかは**サーバーが教えてくれる**。
 * DDM 経路ではレコード配置を自前で推測していた（`ddm/record-layout.ts` が
 * 「仮説に基づく実装」と自ら断っていた）が、ここではその推測が要らない。
 *
 * 並びは結果列の super extended data format と**同一**なので、
 * `db-reply-ext.ts` の読み方と揃えてある（実機の応答で確認済み）。
 *
 * 参照: jtopenlite `DatabaseConnection`（`cp == 0x3813` の分岐）と
 * `JDBCParameterMetaData.parameterMarkerFieldDescription`。逐語移植ではない。
 */
import { As400Error } from "../../errors.js";

/** 固定ヘッダー長。一貫性トークン(4) ＋ 列数(4) ＋ 予約(4) ＋ 行サイズ(4) */
const HEADER_LEN = 16;
/** 1 フィールドの記述子長 */
const FIELD_LEN = 48;

export interface MarkerField {
  /** SQL 型番号（例 453 = CHAR、449 = VARCHAR、497 = INTEGER） */
  sqlType: number;
  /** **マーカーデータの中でこの列が占めるバイト数**（VARCHAR なら長さ 2 バイトを含む） */
  length: number;
  /** 数値の位取り。文字列では文字数が入る */
  scale: number;
  precision: number;
  /** 文字列列の CCSID。数値列は 0 */
  ccsid: number;
  /** 行バッファ内の開始位置（length の累積） */
  offset: number;
}

export interface MarkerFormat {
  fields: MarkerField[];
  /** 1 行のバイト数。サーバーの申告値をそのまま使う */
  rowSize: number;
  /**
   * 受け取ったままのバイト列。
   * **`changeDescriptor` でそのまま送り返す**ため保持する
   * （こちらで組み立て直すと、解釈できていない欄を落としかねない）。
   */
  raw: Uint8Array;
}

/**
 * `0x3813` を解析する。
 *
 * **`rowSize` は自分で足し算せずサーバーの申告を使う**——
 * 型ごとのバイト数を推測しないという方針の要。
 * ただし累積が申告と食い違えば前提が崩れているので拒否する。
 */
export function parseMarkerFormat(value: Uint8Array): MarkerFormat {
  if (value.length < HEADER_LEN) {
    throw new As400Error(
      "PROTOCOL_ERROR",
      `parameter marker format too short (${value.length} bytes)`
    );
  }
  const view = new DataView(value.buffer, value.byteOffset, value.byteLength);
  const fieldCount = view.getUint32(4);
  const rowSize = view.getUint32(12);

  const fields: MarkerField[] = [];
  let offset = 0;
  for (let i = 0; i < fieldCount; i++) {
    const base = HEADER_LEN + i * FIELD_LEN;
    if (base + FIELD_LEN > value.length) {
      throw new As400Error(
        "PROTOCOL_ERROR",
        `parameter marker format truncated at field ${i} (${value.length} bytes)`
      );
    }
    const length = view.getUint32(base + 4);
    fields.push({
      sqlType: view.getUint16(base + 2),
      length,
      scale: view.getUint16(base + 8),
      precision: view.getUint16(base + 10),
      ccsid: view.getUint16(base + 12),
      offset
    });
    offset += length;
  }

  if (offset !== rowSize) {
    // 累積とサーバーの申告が合わない＝並びの読み方が違う。**黙って進めない**
    throw new As400Error(
      "PROTOCOL_ERROR",
      `parameter marker row size mismatch (fields sum ${offset} / server says ${rowSize})`
    );
  }
  return { fields, rowSize, raw: value };
}
