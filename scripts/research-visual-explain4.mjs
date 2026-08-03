/**
 * Visual Explain 調査 4: explain only の可否と、計画ノードの中身。
 *
 * 同一の DB モニター下で 3 ケースを流し、どの記録が出るかを比べる:
 *   A: query()          … prepare + open + fetch（完全実行）
 *   B: openQuery + 即閉じ … prepare + open（行は取らない）
 *   C: executeStatement  … prepare のみ成功し execute が -518 で落ちる（＝prepare だけ）
 */
import { DbConnection, query, executeStatement, SqlError } from "@ts5250/hostserver";

const host = process.env["AS400_HOST"];
const user = process.env["AS400_USER"];
const password = process.env["AS400_PASSWORD"];
const tls = process.argv.includes("--tls");

const line = (s = "") => process.stdout.write(`${s}\n`);

async function step(label, fn) {
  line(`\n--- ${label}`);
  try {
    const r = await fn();
    if (r !== undefined) line(`OK: ${r}`);
    return true;
  } catch (e) {
    if (e instanceof SqlError) line(`NG: SQLCODE=${e.sqlCode} SQLSTATE=${e.sqlState}`);
    else line(`NG: ${String(e).slice(0, 200)}`);
    return false;
  }
}

const stamp = Date.now();
const mk = (t) => `VE4${t}${stamp}`;
const sqlFor = (marker) =>
  `SELECT C.COLUMN_NAME, T.TABLE_TEXT FROM QSYS2.SYSCOLUMNS C, QSYS2.SYSTABLES T ` +
  `WHERE C.TABLE_NAME = T.TABLE_NAME AND C.TABLE_SCHEMA = 'QSYS2' AND '${marker}' = '${marker}'`;

async function main() {
  line(`host=${host} tls=${tls}`);
  const conn = await DbConnection.connect({ host, user, password, tls });
  try {
    await step("STRDBMON(自ジョブ)", () =>
      executeStatement(conn, "CALL QSYS2.QCMDEXC('STRDBMON OUTFILE(QTEMP/VE4) JOB(*) TYPE(*DETAIL)')")
    );

    await step(`A: query() 完全実行 ${mk("A")}`, async () => {
      const r = await query(conn, `${sqlFor(mk("A"))} FETCH FIRST 5 ROWS ONLY`);
      return `rows=${r.rows.length}`;
    });

    await step(`C: executeStatement に SELECT（prepare だけ通る想定）${mk("C")}`, () =>
      executeStatement(conn, `${sqlFor(mk("C"))} FETCH FIRST 5 ROWS ONLY`)
    );

    // B（openQuery して行を取らずに閉じる）は、ジェネレータを 1 度も回さずに return() すると
    // finally が走らず接続ロックが残るため、この経路では試せない（それ自体が発見）。

    await step("ENDDBMON", () => executeStatement(conn, "CALL QSYS2.QCMDEXC('ENDDBMON JOB(*)')"));

    for (const t of ["A", "C"]) {
      await step(`${t}: 記録された QQRID`, async () => {
        const r = await query(
          conn,
          `SELECT CAST(QQRID AS VARCHAR(6)) CONCAT ' x' CONCAT CAST(COUNT(*) AS VARCHAR(4)) AS X ` +
            `FROM QTEMP.VE4 WHERE QQUCNT IN (SELECT DISTINCT QQUCNT FROM QTEMP.VE4 WHERE QQ1000 LIKE '%${mk(t)}%') ` +
            `GROUP BY QQRID ORDER BY QQRID`
        );
        return r.rows.map((x) => x["X"]).join(" ") || "(なし)";
      });
    }

    await step("A の計画ノード（主要列）", async () => {
      const r = await query(
        conn,
        `SELECT CAST(CAST(QQRID AS VARCHAR(6)) CONCAT ' tbl=' CONCAT COALESCE(QVQLIB,'-') CONCAT '/' CONCAT COALESCE(QVQTBL,'-') ` +
          `CONCAT ' idx=' CONCAT COALESCE(QVILIB,'-') CONCAT '/' CONCAT COALESCE(QVINAM,'-') ` +
          `CONCAT ' rows=' CONCAT COALESCE(CAST(QQTOTR AS VARCHAR(12)),'-') ` +
          `CONCAT ' est=' CONCAT COALESCE(CAST(QQREST AS VARCHAR(12)),'-') ` +
          `CONCAT ' ms=' CONCAT COALESCE(CAST(QQEPT AS VARCHAR(12)),'-') ` +
          `CONCAT ' idxadv=' CONCAT COALESCE(QQIDXA,'-') ` +
          `CONCAT ' rc=' CONCAT COALESCE(CAST(QQRCOD AS VARCHAR(6)),'-') AS VARCHAR(220)) AS X ` +
          `FROM QTEMP.VE4 WHERE QQUCNT IN (SELECT DISTINCT QQUCNT FROM QTEMP.VE4 WHERE QQ1000 LIKE '%${mk("A")}%') ` +
          `ORDER BY QQRID`
      );
      for (const row of r.rows) line(`   ${row["X"]}`);
      return `${r.rows.length} 件`;
    });

    await step("A の索引助言（QQIDXD）", async () => {
      const r = await query(
        conn,
        `SELECT CAST(COALESCE(SUBSTR(QQIDXD,1,180),'-') AS VARCHAR(200)) AS X FROM QTEMP.VE4 ` +
          `WHERE QQIDXA = 'Y' AND QQUCNT IN (SELECT DISTINCT QQUCNT FROM QTEMP.VE4 WHERE QQ1000 LIKE '%${mk("A")}%')`
      );
      for (const row of r.rows) line(`   ${row["X"]}`);
      return `${r.rows.length} 件`;
    });
  } finally {
    conn.close();
  }
}

main().catch((e) => {
  line(`FATAL: ${String(e)}`);
  process.exit(1);
});
