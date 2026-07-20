/**
 * 表の列レイアウトを SQL（`QSYS2.SYSCOLUMNS`）から得る。
 *
 * **DDM の record format reader を実装しない**という判断の帰結（`record-layout.ts` の説明を参照）。
 * 原典は `DDMRecordFormatReader` ＋ `DDMField`（1,220 行）でこれを行うが、
 * このプロジェクトには実機で検証済みの SQL があるため、そちらから引く。
 *
 * 以前は検証スクリプト（`tools/hostserver-check`）の中にだけ同じ問い合わせがあった。
 * **2 つの SYSCOLUMNS クエリが並立しないよう**、製品コードはここ 1 か所にする。
 */
import { As400Error } from "../../errors.js";
import type { DbConnection } from "../db/db-connection.js";
import { query } from "../db/query.js";
import type { ColumnLayoutInput } from "./record-layout.js";
import { assertIdentifier } from "../../identifier.js";

export { assertIdentifier } from "../../identifier.js";

/**
 * 列の情報を宣言順で返す。
 *
 * **`ORDER BY ORDINAL_POSITION` は必須**——`buildRecordLayout` が宣言順に
 * オフセットを積み上げるため、並びが変わるとレコード全体がずれる。
 *
 * `CCSID` も取る。書き込みは列ごとの CCSID で符号化する（design D1）。
 */
export async function fetchColumnLayout(
  db: DbConnection,
  library: string,
  table: string
): Promise<ColumnLayoutInput[]> {
  const lib = assertIdentifier(library, "ライブラリ名");
  const tbl = assertIdentifier(table, "ファイル名");

  const res = await query(
    db,
    `SELECT COLUMN_NAME, DATA_TYPE, LENGTH, NUMERIC_SCALE, IS_NULLABLE, CCSID ` +
      `FROM QSYS2.SYSCOLUMNS WHERE TABLE_SCHEMA='${lib}' AND TABLE_NAME='${tbl}' ` +
      `ORDER BY ORDINAL_POSITION`
  );

  if (res.rows.length === 0) {
    // 表が無い場合と、権限が無くてカタログに見えない場合を**区別できない**（どちらも 0 行）。
    // 見えない理由を推測して案内すると外すので、事実だけを返す
    throw new As400Error(
      "CONFIG_ERROR",
      `列が見つかりません: ${lib}/${tbl}（存在しないか、参照する権限がありません）`
    );
  }

  return res.rows.map((r) => {
    const ccsid = r["CCSID"];
    return {
      name: String(r["COLUMN_NAME"]).trim(),
      dataType: String(r["DATA_TYPE"]).trim(),
      length: Number(r["LENGTH"]),
      scale: Number(r["NUMERIC_SCALE"] ?? 0),
      nullable: String(r["IS_NULLABLE"]).trim() === "Y",
      // 数値列は NULL で返る。**0 も「無し」として扱う**（実機で数値列が 0 を返す）
      ...(ccsid !== null && ccsid !== undefined && Number(ccsid) > 0
        ? { ccsid: Number(ccsid) }
        : {})
    };
  });
}
