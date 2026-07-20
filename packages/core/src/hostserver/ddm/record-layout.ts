/**
 * SQL のメタデータ（`QSYS2.SYSCOLUMNS` 相当）から、物理レコードのバイト配置を組み立てる。
 *
 * **DDM の record format reader を実装しない**という設計判断による（spec D1）。
 * 原典（jtopenlite）は `DDMRecordFormatReader` ＋ `DDMField`（1,220 行）で列情報を扱うが、
 * このプロジェクトには既に実機で検証済みの SQL があるため、そちらから配置を導く。
 *
 * ⚠ **これは仮説に基づく実装である**——「固定長の列が宣言順に連続配置される」ことを
 * 前提にしている。実機で書いて **SQL で読み返して**検証すること（別経路の確認）。
 * 前提が崩れる型（可変長・日付時刻・DBCS）は**受け付けずに失敗させる**。
 */
import { As400Error } from "../../errors.js";

/** SQL から得られる 1 列の情報（必要な分だけ） */
export interface ColumnLayoutInput {
  name: string;
  /** `QSYS2.SYSCOLUMNS.DATA_TYPE`（例 "CHAR" / "DECIMAL"） */
  dataType: string;
  /**
   * `CHAR` は**バイト数**、数値は精度（桁数）。
   *
   * 混在 CCSID（5035 等）でも `CHAR(n)` の `n` はバイト数である——実機の
   * `QSYS2.SYSCOLUMNS` で `LENGTH` = `CHARACTER_MAXIMUM_LENGTH` = `CHARACTER_OCTET_LENGTH`
   * が一致することを確認済み（research F8）。SO/SI もこの n バイトを消費する。
   */
  length: number;
  scale: number;
  nullable: boolean;
  /**
   * 文字列列の CCSID（`QSYS2.SYSCOLUMNS.CCSID`）。数値列では未設定。
   *
   * **列ごとに持つ**のが要点（design D1）。原典も `DDMField.getCCSID()`（`WHCCSID`）で
   * フィールド単位に持っており、同じ表に CCSID 273 の列と 5035 の列が同居しうる。
   */
  ccsid?: number;
}

export type FieldKind = "char" | "packed" | "zoned" | "int";

export interface FieldLayout {
  name: string;
  kind: FieldKind;
  /** レコードバッファ内の開始位置 */
  offset: number;
  /** 占めるバイト数 */
  size: number;
  /** 数値の精度（char では未使用） */
  precision: number;
  scale: number;
  nullable: boolean;
  /** `char` のときのみ。符号化に使う CCSID */
  ccsid?: number;
}

export interface RecordLayout {
  fields: FieldLayout[];
  /** 固定部の合計バイト数。S38OPNFB の recordLength と一致するはず */
  recordLength: number;
}

/**
 * 対応する型かどうか。**対応集合の定義はここ 1 か所**にする——
 * 事前検査（`upload-prepare.ts`）が同じ判定を独自に持つと、片方だけ更新されて食い違う。
 */
export function isSupportedDataType(dataType: string): boolean {
  return SUPPORTED_TYPES.has(dataType.trim().toUpperCase());
}

const SUPPORTED_TYPES = new Set(["CHAR", "DECIMAL", "NUMERIC", "SMALLINT", "INTEGER", "BIGINT"]);

/** 型ごとのバイト数。**ここが配置計算の核心** */
function sizeOf(input: ColumnLayoutInput): { kind: FieldKind; size: number } {
  const t = input.dataType.trim().toUpperCase();
  switch (t) {
    case "CHAR":
      return { kind: "char", size: input.length };
    case "DECIMAL":
      // パック 10 進: 1 バイトに 2 桁 ＋ 符号ニブル
      return { kind: "packed", size: Math.floor(input.length / 2) + 1 };
    case "NUMERIC":
      // ゾーン 10 進: 1 バイトに 1 桁
      return { kind: "zoned", size: input.length };
    case "SMALLINT":
      return { kind: "int", size: 2 };
    case "INTEGER":
      return { kind: "int", size: 4 };
    case "BIGINT":
      return { kind: "int", size: 8 };
    default:
      // **黙って壊れた値を書かない**（spec D2）。対応外は型名を添えて拒否する
      throw new As400Error(
        // **利用者が選んだ表の問題**なので、実装の未対応（HOST_SERVER_UNSUPPORTED）とは分ける
        "UNSUPPORTED_TYPE",
        `DDM 書き込みが対応していない型です: ${input.name} (${t})。` +
          `対応: CHAR / DECIMAL / NUMERIC / SMALLINT / INTEGER / BIGINT`
      );
  }
}

/**
 * 列の並びからレコード配置を作る。**列は宣言順（ORDINAL_POSITION 順）で渡すこと**。
 *
 * 対応外の型が 1 つでもあれば、**レコード全体を拒否する**（部分的に書けても意味が無いため）。
 */
export function buildRecordLayout(columns: readonly ColumnLayoutInput[]): RecordLayout {
  if (columns.length === 0) {
    throw new As400Error("CONFIG_ERROR", "列がありません");
  }
  const fields: FieldLayout[] = [];
  let offset = 0;
  for (const c of columns) {
    const { kind, size } = sizeOf(c);
    fields.push({
      name: c.name,
      kind,
      offset,
      size,
      precision: c.length,
      scale: c.scale,
      nullable: c.nullable,
      // 文字列列にだけ運ぶ。数値列は CCSID を使わないので、持たせると符号化側で「使わない値」を
      // 無視する判断が要る。存在しないなら分岐そのものが要らない
      ...(kind === "char" && c.ccsid !== undefined ? { ccsid: c.ccsid } : {})
    });
    offset += size;
  }
  return { fields, recordLength: offset };
}
