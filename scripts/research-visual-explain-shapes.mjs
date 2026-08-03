/**
 * design 用の実測: 計画の「形」を決める 2 点を確かめる。
 *   (1) QQQDTN / QQQDTL（query definition template number / level）で階層が組めるか
 *   (2) 結合・集約・副問合せで出る記録種別と、そこで埋まる列
 *
 * QTEMP に作った表だけを使う（実データに触れない・接続を閉じれば消える）。
 */
import { DbConnection, query, executeStatement, SqlError } from "@ts5250/hostserver";

const which = process.argv[2] === "pub400" ? "pub400" : "as400";
const cfg =
  which === "pub400"
    ? { host: process.env["PUB400_HOST"] ?? "pub400.com", user: process.env["PUB400_USER"], password: process.env["PUB400_PASSWORD"], tls: true }
    : { host: process.env["AS400_HOST"], user: process.env["AS400_USER"], password: process.env["AS400_PASSWORD"], tls: false };

const line = (s = "") => process.stdout.write(`${s}\n`);

async function step(label, fn) {
  line(`\n--- ${label}`);
  try {
    const r = await fn();
    if (r !== undefined) line(`OK: ${r}`);
    return r;
  } catch (e) {
    if (e instanceof SqlError) line(`NG: SQLCODE=${e.sqlCode} SQLSTATE=${e.sqlState}`);
    else line(`NG: ${String(e).slice(0, 200)}`);
    return undefined;
  }
}

/** 監視下で流す SQL。形の違いで出る記録種別が変わるはず */
const SHAPES = [
  { tag: "SCAN", sql: "SELECT COUNT(*) AS N FROM QTEMP.VT1 WHERE K > 100" },
  { tag: "JOIN", sql: "SELECT COUNT(*) AS N FROM QTEMP.VT1 A INNER JOIN QTEMP.VT2 B ON A.K = B.K" },
  { tag: "GROUP", sql: "SELECT K, COUNT(*) AS N FROM QTEMP.VT1 GROUP BY K ORDER BY 2 DESC FETCH FIRST 5 ROWS ONLY" },
  { tag: "SUBQ", sql: "SELECT COUNT(*) AS N FROM QTEMP.VT1 WHERE K IN (SELECT K FROM QTEMP.VT2)" },
  { tag: "UNION", sql: "SELECT COUNT(*) AS N FROM (SELECT K FROM QTEMP.VT1 UNION SELECT K FROM QTEMP.VT2) X" }
];

async function main() {
  line(`### ${which} host=${cfg.host}`);
  const conn = await DbConnection.connect(cfg);
  try {
    await step("QTEMP に検証用の表を作る", async () => {
      await executeStatement(
        conn,
        "CREATE TABLE QTEMP.VT1 AS (SELECT CAST(ORDINAL_POSITION AS INTEGER) AS K, CAST(COLUMN_NAME AS CHAR(30)) AS NM FROM QSYS2.SYSCOLUMNS WHERE TABLE_SCHEMA = 'QSYS2') WITH DATA"
      );
      await executeStatement(
        conn,
        // SYSTABLES に ORDINAL_POSITION は無い（-206 を踏んだ）。SYSCOLUMNS を別スキーマで引く
        "CREATE TABLE QTEMP.VT2 AS (SELECT CAST(ORDINAL_POSITION AS INTEGER) AS K, CAST(TABLE_NAME AS CHAR(30)) AS TN FROM QSYS2.SYSCOLUMNS WHERE TABLE_SCHEMA = 'QSYS') WITH DATA"
      );
      const a = await query(conn, "SELECT COUNT(*) AS N FROM QTEMP.VT1");
      const b = await query(conn, "SELECT COUNT(*) AS N FROM QTEMP.VT2");
      return `VT1=${JSON.stringify(a.rows[0])} VT2=${JSON.stringify(b.rows[0])}`;
    });

    await step("STRDBMON", () =>
      executeStatement(conn, "CALL QSYS2.QCMDEXC('STRDBMON OUTFILE(QTEMP/VSHP) JOB(*) TYPE(*DETAIL)')")
    );
    for (const s of SHAPES) {
      await step(`${s.tag}: ${s.sql.slice(0, 70)}`, async () => {
        const r = await query(conn, s.sql);
        return `rows=${r.rows.length}`;
      });
    }
    await step("ENDDBMON", () => executeStatement(conn, "CALL QSYS2.QCMDEXC('ENDDBMON JOB(*)')"));

    for (const s of SHAPES) {
      const key = s.tag === "SCAN" ? "WHERE K >" : s.tag === "JOIN" ? "INNER JOIN" : s.tag === "GROUP" ? "GROUP BY K" : s.tag === "SUBQ" ? "K IN (SELECT" : "UNION SELECT";
      await step(`${s.tag}: 記録種別と階層列（QQRID / QQQDTN / QQQDTL / QQMATN / QQMATL）`, async () => {
        const r = await query(
          conn,
          `SELECT CAST(CAST(QQRID AS VARCHAR(6)) CONCAT ' dtn=' CONCAT COALESCE(CAST(QQQDTN AS VARCHAR(8)),'-') ` +
            `CONCAT ' dtl=' CONCAT COALESCE(CAST(QQQDTL AS VARCHAR(8)),'-') ` +
            `CONCAT ' matn=' CONCAT COALESCE(CAST(QQMATN AS VARCHAR(8)),'-') ` +
            `CONCAT ' matl=' CONCAT COALESCE(CAST(QQMATL AS VARCHAR(8)),'-') ` +
            `CONCAT ' tbl=' CONCAT COALESCE(QVQTBL,'-') CONCAT ' idx=' CONCAT COALESCE(QVINAM,'-') ` +
            `CONCAT ' rc=' CONCAT COALESCE(CAST(QQRCOD AS VARCHAR(6)),'-') AS VARCHAR(200)) AS X ` +
            `FROM QTEMP.VSHP WHERE QQUCNT IN (SELECT DISTINCT QQUCNT FROM QTEMP.VSHP WHERE QQ1000 LIKE '%${key}%') ` +
            `AND QQRID BETWEEN 3000 AND 3099 ORDER BY QQRID`
        );
        for (const row of r.rows) line(`   ${row["X"]}`);
        return `${r.rows.length} 件`;
      });
    }

    await step("全体: 出現した記録種別", async () => {
      const r = await query(
        conn,
        "SELECT CAST(CAST(QQRID AS VARCHAR(6)) CONCAT ':' CONCAT CAST(COUNT(*) AS VARCHAR(4)) AS VARCHAR(20)) AS X FROM QTEMP.VSHP GROUP BY QQRID ORDER BY QQRID"
      );
      return r.rows.map((x) => x["X"]).join(" ");
    });
  } finally {
    conn.close();
  }
}

main().catch((e) => {
  line(`FATAL: ${String(e)}`);
  process.exit(1);
});
