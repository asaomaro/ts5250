import { describe, it, expect } from "vitest";
import { isNonQueryStatement, hasParameterMarker } from "../src/db/statement-kind.js";

/**
 * 文の振り分け。**誤ると利用者に「SELECT を書いたのに実行できない」と見える**
 * （非クエリ経路へ流れた SELECT は `-518 / 07003` で落ちる。
 * `20260730-sql-non-query-statements` research F5）。
 *
 * spec の境界表をそのまま固定する。
 */
describe("クエリと見なす（false）", () => {
  const QUERIES = [
    "SELECT * FROM QTEMP.T",
    "  select 1 from sysibm.sysdummy1",
    "\n\tSELECT 1 FROM SYSIBM.SYSDUMMY1",
    "-- 顧客を数える\nSELECT COUNT(*) FROM T",
    "/* c */ SELECT 1 FROM SYSIBM.SYSDUMMY1",
    "/* 複数\n行 */\n-- そして行コメント\nSELECT 1 FROM SYSIBM.SYSDUMMY1",
    "WITH t AS (SELECT 1 AS N FROM SYSIBM.SYSDUMMY1) SELECT N FROM t",
    "(SELECT 1 FROM SYSIBM.SYSDUMMY1) UNION (SELECT 2 FROM SYSIBM.SYSDUMMY1)",
    "VALUES(1)",
    "TABLE QTEMP.T"
  ];
  for (const sql of QUERIES) {
    it(JSON.stringify(sql), () => expect(isNonQueryStatement(sql)).toBe(false));
  }

  it("空文字・コメントだけはクエリ扱い（実行させず既存の経路に断らせる）", () => {
    expect(isNonQueryStatement("")).toBe(false);
    expect(isNonQueryStatement("   \n ")).toBe(false);
    expect(isNonQueryStatement("-- なにもしない")).toBe(false);
    expect(isNonQueryStatement("/* まだ書いていない */")).toBe(false);
  });

  it("閉じていないコメントもクエリ扱い（先頭語が取れない）", () => {
    expect(isNonQueryStatement("/* 閉じ忘れ DELETE FROM T")).toBe(false);
  });
});

describe("非クエリと見なす（true）", () => {
  const NON_QUERIES = [
    "INSERT INTO QTEMP.T VALUES(1)",
    "insert into qtemp.t values(1)",
    "UPDATE QTEMP.T SET S = 'z'",
    "DELETE FROM QTEMP.T WHERE ID = 1",
    "MERGE INTO T USING S ON T.ID = S.ID WHEN MATCHED THEN UPDATE SET T.S = S.S",
    "CREATE TABLE QTEMP.T (ID INT)",
    "DROP TABLE QTEMP.T",
    "ALTER TABLE T ADD COLUMN C INT",
    "RENAME TABLE T TO U",
    "TRUNCATE TABLE T",
    "GRANT SELECT ON T TO PUBLIC",
    "REVOKE SELECT ON T FROM PUBLIC",
    "COMMENT ON TABLE T IS '説明'",
    "LABEL ON TABLE T IS '見出し'",
    "SET SCHEMA TESTLIB",
    "CALL QSYS.QCMDEXC('DSPLIBL', 0000000008.00000)",
    "-- 消す\nDELETE FROM QTEMP.T",
    "/* 消す */ DELETE FROM QTEMP.T"
  ];
  for (const sql of NON_QUERIES) {
    it(JSON.stringify(sql), () => expect(isNonQueryStatement(sql)).toBe(true));
  }

  it("SELECTX は SELECT ではない（語境界で判定する）", () => {
    expect(isNonQueryStatement("SELECTX 1")).toBe(true);
    expect(isNonQueryStatement("WITHOUT 1")).toBe(true);
  });
});

describe("パラメータマーカー", () => {
  it("? を含む文は見つける", () => {
    expect(hasParameterMarker("INSERT INTO T VALUES(?)")).toBe(true);
    expect(hasParameterMarker("UPDATE T SET S = ? WHERE ID = ?")).toBe(true);
  });

  it("文字列リテラルの中の ? は数えない", () => {
    expect(hasParameterMarker("UPDATE T SET S = '?'")).toBe(false);
    expect(hasParameterMarker(`UPDATE T SET S = "?"`)).toBe(false);
    // `''` は埋め込まれた引用符。ここで閉じたと誤ると後続の ? を拾う
    expect(hasParameterMarker("UPDATE T SET S = 'it''s ?'")).toBe(false);
  });

  it("コメントの中の ? は数えない（正しい文を断らないため）", () => {
    expect(hasParameterMarker("DELETE FROM T -- 本当に消す?\n")).toBe(false);
    expect(hasParameterMarker("DELETE FROM T -- 本当に消す?")).toBe(false);
    expect(hasParameterMarker("/* どうする? */ DELETE FROM T")).toBe(false);
    // コメントの後ろの ? は数える（飛ばしすぎない）
    expect(hasParameterMarker("/* c */ DELETE FROM T WHERE ID = ?")).toBe(true);
    expect(hasParameterMarker("-- c\nDELETE FROM T WHERE ID = ?")).toBe(true);
  });

  it("文字列の中の -- はコメントではない", () => {
    expect(hasParameterMarker("UPDATE T SET S = '--' WHERE ID = ?")).toBe(true);
  });
});
