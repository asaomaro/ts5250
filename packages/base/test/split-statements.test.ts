import { describe, it, expect } from "vitest";
import { splitSqlStatements, summarizeSql } from "../src/split-statements.js";

/**
 * `;` の分割。**「区切りに見えるが区切りでないもの」を外すのが本体**なので、
 * 境界（文字列・識別子・コメント・閉じ忘れ）を落とさないよう並べる。
 */
const sqls = (text: string): string[] => splitSqlStatements(text).map((s) => s.sql);

describe("splitSqlStatements", () => {
  it("素直な 2 文を分ける", () => {
    expect(sqls("SELECT 1 FROM A; SELECT 2 FROM B")).toEqual([
      "SELECT 1 FROM A",
      "SELECT 2 FROM B"
    ]);
  });

  it("末尾の `;` は空文を作らない", () => {
    expect(sqls("SELECT 1 FROM A;")).toEqual(["SELECT 1 FROM A"]);
    expect(sqls("SELECT 1 FROM A;  \n ")).toEqual(["SELECT 1 FROM A"]);
  });

  it("空の区切り（`;;`）を捨てる", () => {
    expect(sqls("SELECT 1;; SELECT 2")).toEqual(["SELECT 1", "SELECT 2"]);
  });

  it("`;` が無ければ 1 文", () => {
    expect(sqls("SELECT * FROM MARO.T")).toEqual(["SELECT * FROM MARO.T"]);
  });

  it("空白だけ・コメントだけなら 0 文", () => {
    expect(sqls("   \n\t ")).toEqual([]);
    expect(sqls("-- ただのメモ")).toEqual([]);
    expect(sqls("/* まだ書いていない */")).toEqual([]);
    expect(sqls(";;;")).toEqual([]);
  });

  /** ここが本体。`'A;B'` を割ると壊れた 2 文になる */
  it("文字列の中の `;` では分割しない", () => {
    expect(sqls("SELECT * FROM T WHERE NAME = 'A;B'")).toEqual([
      "SELECT * FROM T WHERE NAME = 'A;B'"
    ]);
  });

  it("`''` でエスケープされた引用符を跨いで判定する", () => {
    expect(sqls("SELECT 'It''s; ok' FROM T; SELECT 2")).toEqual([
      "SELECT 'It''s; ok' FROM T",
      "SELECT 2"
    ]);
  });

  it("引用符付き識別子の中の `;` では分割しない", () => {
    expect(sqls('SELECT * FROM "MY;TABLE"; SELECT 2')).toEqual([
      'SELECT * FROM "MY;TABLE"',
      "SELECT 2"
    ]);
  });

  it("行コメントの中の `;` では分割しない", () => {
    expect(sqls("SELECT 1 -- ; ここはコメント\nFROM T; SELECT 2")).toEqual([
      "SELECT 1 -- ; ここはコメント\nFROM T",
      "SELECT 2"
    ]);
  });

  it("ブロックコメントの中の `;` では分割しない", () => {
    expect(sqls("SELECT 1 /* ; まだ中 */ FROM T; SELECT 2")).toEqual([
      "SELECT 1 /* ; まだ中 */ FROM T",
      "SELECT 2"
    ]);
  });

  /** 文字列の中の `--` はコメントではない（値として `;` を含める） */
  it("文字列の中の `--` をコメントと見なさない", () => {
    expect(sqls("SELECT '-- not ; comment' FROM T; SELECT 2")).toEqual([
      "SELECT '-- not ; comment' FROM T",
      "SELECT 2"
    ]);
  });

  it("閉じていない文字列・コメントは、そこから末尾までを 1 文にする", () => {
    // ホストに構文エラーを返させる方が、こちらで弾くより情報が多い
    expect(sqls("SELECT 'abc; SELECT 2")).toEqual(["SELECT 'abc; SELECT 2"]);
    expect(sqls("SELECT 1; /* 閉じ忘れ ; SELECT 2")).toEqual(["SELECT 1"]);
  });

  it("開始位置を返す（エラー案内に使う）", () => {
    const got = splitSqlStatements("SELECT 1;\n  SELECT 2");
    expect(got.map((s) => s.offset)).toEqual([0, 12]);
    expect(got[1]?.sql).toBe("SELECT 2");
  });

  it("改行を含む文をそのまま保つ", () => {
    expect(sqls("SELECT 1\n  FROM T\n;SELECT 2")).toEqual(["SELECT 1\n  FROM T", "SELECT 2"]);
  });
});

describe("summarizeSql", () => {
  it("改行と連続する空白を潰す", () => {
    expect(summarizeSql("SELECT   1\n  FROM T")).toBe("SELECT 1 FROM T");
  });

  /** 見出しに「-- メモ」とだけ出ても、どの文の結果か分からない（実機の画面で気づいた） */
  it("先頭のコメントを飛ばして本文を出す", () => {
    expect(summarizeSql("-- 2 つ目\nSELECT A FROM T")).toBe("SELECT A FROM T");
    expect(summarizeSql("/* メモ */ SELECT B FROM T")).toBe("SELECT B FROM T");
    // コメントだけなら、そのコメントを出す（空にしない）
    expect(summarizeSql("-- メモだけ")).toBe("-- メモだけ");
  });

  it("長い文は切り詰める", () => {
    expect(summarizeSql("SELECT ABCDEFGHIJKLMNOPQRSTUVWXYZ FROM T", 10)).toBe("SELECT AB…");
  });
});

/**
 * **複合文の中の `;` は区切りではない**（利用者の要望で SQL 画面から手続き・関数を
 * 作れるようにした）。素朴に切ると `CREATE PROCEDURE … BEGIN … END` が壊れた断片になり、
 * 手続き・関数・トリガーを 1 つも作れない（実機で確認）。
 */
describe("splitSqlStatements: 複合文", () => {
  const sqls = (t: string): string[] => splitSqlStatements(t).map((s) => s.sql);

  it("BEGIN … END の中の `;` では切らない", () => {
    const text = [
      "CREATE PROCEDURE P (IN X INT)",
      "LANGUAGE SQL",
      "BEGIN",
      "  UPDATE T SET A = 1 WHERE ID = X;",
      "  DELETE FROM U WHERE ID = X;",
      "END;",
      "SELECT * FROM T"
    ].join("\n");
    const got = sqls(text);
    expect(got).toHaveLength(2);
    expect(got[0]).toContain("BEGIN");
    expect(got[0]).toContain("END");
    expect(got[1]).toBe("SELECT * FROM T");
  });

  it("入れ子（IF / CASE / ループ）でも本体を保つ", () => {
    const text = [
      "CREATE PROCEDURE P ()",
      "BEGIN",
      "  IF A > 0 THEN",
      "    SET B = CASE WHEN A IS NULL THEN 0 ELSE A END;",
      "  END IF;",
      "  WHILE A > 0 DO",
      "    SET A = A - 1;",
      "  END WHILE;",
      "END;",
      "SELECT 1 FROM T"
    ].join("\n");
    expect(sqls(text)).toHaveLength(2);
  });

  /**
   * `DECLARE … CURSOR FOR` と `DECLARE … HANDLER FOR` は手続きの本体に普通に現れる。
   * ここを FOR ループと取り違えると深さが戻らず、**以降の文をすべて飲み込む**。
   */
  it("CURSOR FOR / HANDLER FOR をループと取り違えない", () => {
    const text = [
      "CREATE PROCEDURE P ()",
      "BEGIN",
      "  DECLARE C CURSOR FOR SELECT ID FROM T;",
      "  DECLARE CONTINUE HANDLER FOR SQLEXCEPTION SET X = 1;",
      "  OPEN C;",
      "END;",
      "SELECT 2 FROM T"
    ].join("\n");
    expect(sqls(text)).toHaveLength(2);
  });

  it("FOR ループ（END FOR）は釣り合う", () => {
    const text = [
      "CREATE PROCEDURE P ()",
      "BEGIN",
      "  FOR R AS C2 CURSOR FOR SELECT ID FROM T DO",
      "    INSERT INTO U VALUES (R.ID);",
      "  END FOR;",
      "END;",
      "SELECT 3 FROM T"
    ].join("\n");
    expect(sqls(text)).toHaveLength(2);
  });

  it("トリガーの `FOR EACH ROW` はループではない", () => {
    const text = [
      "CREATE TRIGGER G AFTER INSERT ON T",
      "  REFERENCING NEW AS N FOR EACH ROW MODE DB2SQL",
      "BEGIN",
      "  INSERT INTO L VALUES (N.ID);",
      "END;",
      "SELECT 4 FROM T"
    ].join("\n");
    expect(sqls(text)).toHaveLength(2);
  });

  /** 複合文の外は今までどおり。ここが変わると普段の複数文実行が壊れる */
  it("素の文は従来どおり切る（式の CASE … END に引きずられない）", () => {
    expect(sqls("SELECT CASE WHEN 1=1 THEN 'a' END FROM D; SELECT 2 FROM D")).toEqual([
      "SELECT CASE WHEN 1=1 THEN 'a' END FROM D",
      "SELECT 2 FROM D"
    ]);
    expect(sqls("CREATE TABLE T (C CHAR(10) FOR BIT DATA); SELECT 1 FROM T")).toHaveLength(2);
    expect(sqls("SELECT * FROM T FOR READ ONLY; SELECT 1 FROM T")).toHaveLength(2);
  });

  /** 余った `END` で以降が壊れないこと（深さは 0 より下げない） */
  it("釣り合わない END があっても後続の文を失わない", () => {
    expect(sqls("END; SELECT 1 FROM T; SELECT 2 FROM T")).toHaveLength(3);
  });
});
