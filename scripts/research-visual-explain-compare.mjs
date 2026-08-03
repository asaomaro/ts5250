/**
 * Visual Explain 追加調査: 2 機を同じ手順で測って突き合わせる。
 *
 *   node --env-file=.env scripts/research-visual-explain-compare.mjs as400
 *   node --env-file=.env scripts/research-visual-explain-compare.mjs pub400
 *
 * 調べること:
 *   (1) PLAN_IDENTIFIER の在りか（ダンプ表のどの列か）と、DUMP_PLAN_CACHE 単一取得の成否
 *   (2) **同一 SQL** での記録種別の突き合わせ（版数差を SQL 差と混同しないため）
 */
import { DbConnection, query, executeStatement, SqlError } from "@ts5250/hostserver";

const which = process.argv[2] === "pub400" ? "pub400" : "as400";
const cfg =
  which === "pub400"
    ? {
        host: process.env["PUB400_HOST"] ?? "pub400.com",
        user: process.env["PUB400_USER"],
        password: process.env["PUB400_PASSWORD"],
        tls: true
      }
    : {
        host: process.env["AS400_HOST"],
        user: process.env["AS400_USER"],
        password: process.env["AS400_PASSWORD"],
        tls: false
      };

const line = (s = "") => process.stdout.write(`${s}\n`);

async function step(label, fn) {
  line(`\n--- ${label}`);
  try {
    const r = await fn();
    if (r !== undefined) line(`OK: ${r}`);
    return r ?? true;
  } catch (e) {
    if (e instanceof SqlError) line(`NG: SQLCODE=${e.sqlCode} SQLSTATE=${e.sqlState}`);
    else line(`NG: ${String(e).slice(0, 200)}`);
    return undefined;
  }
}

/** 突き合わせ用の同一 SQL。両機に在る表だけを使い、リテラルも同一にする */
const SAME_SQL = "SELECT COUNT(*) AS N FROM QSYS2.SYSCOLUMNS WHERE TABLE_SCHEMA = 'QSYS2'";

/** PLAN_IDENTIFIER の候補になりうる数値列 */
const ID_CANDIDATES = ["QQBGINT1", "QQBGINT2", "QQI5", "QQI6", "QQI7", "QQINT01", "QQINT02", "QQINT05"];

async function main() {
  line(`### ${which} host=${cfg.host} tls=${cfg.tls}`);
  const conn = await DbConnection.connect(cfg);
  try {
    // ---------- (2) 同一 SQL での記録種別 ----------
    await step("STRDBMON", () =>
      executeStatement(conn, "CALL QSYS2.QCMDEXC('STRDBMON OUTFILE(QTEMP/VCMP) JOB(*) TYPE(*DETAIL)')")
    );
    await step(`同一 SQL を実行: ${SAME_SQL}`, async () => {
      const r = await query(conn, SAME_SQL);
      return JSON.stringify(r.rows[0]);
    });
    await step("ENDDBMON", () => executeStatement(conn, "CALL QSYS2.QCMDEXC('ENDDBMON JOB(*)')"));

    await step("同一 SQL の記録種別（QQRID x 件数）", async () => {
      const r = await query(
        conn,
        `SELECT CAST(CAST(QQRID AS VARCHAR(6)) CONCAT ':' CONCAT CAST(COUNT(*) AS VARCHAR(4)) AS VARCHAR(20)) AS X ` +
          `FROM QTEMP.VCMP WHERE QQUCNT IN (SELECT DISTINCT QQUCNT FROM QTEMP.VCMP WHERE QQ1000 LIKE '%SYSCOLUMNS WHERE TABLE_SCHEMA%') ` +
          `GROUP BY QQRID ORDER BY QQRID`
      );
      return r.rows.map((x) => x["X"]).join(" ") || "(なし)";
    });

    await step("同一 SQL の計画ノード", async () => {
      const r = await query(
        conn,
        `SELECT CAST(CAST(QQRID AS VARCHAR(6)) CONCAT ' tbl=' CONCAT COALESCE(QVQLIB,'-') CONCAT '/' CONCAT COALESCE(QVQTBL,'-') ` +
          `CONCAT ' idx=' CONCAT COALESCE(QVINAM,'-') CONCAT ' rows=' CONCAT COALESCE(CAST(QQTOTR AS VARCHAR(14)),'-') ` +
          `CONCAT ' est=' CONCAT COALESCE(CAST(QQREST AS VARCHAR(14)),'-') CONCAT ' idxadv=' CONCAT COALESCE(QQIDXA,'-') ` +
          `CONCAT ' rc=' CONCAT COALESCE(CAST(QQRCOD AS VARCHAR(6)),'-') AS VARCHAR(200)) AS X ` +
          `FROM QTEMP.VCMP WHERE QQUCNT IN (SELECT DISTINCT QQUCNT FROM QTEMP.VCMP WHERE QQ1000 LIKE '%SYSCOLUMNS WHERE TABLE_SCHEMA%') ` +
          `AND QQRID IN (3000,3001,3002,3003,3006,3020) ORDER BY QQRID`
      );
      for (const row of r.rows) line(`   ${row["X"]}`);
      return `${r.rows.length} 件`;
    });

    // ---------- (1) PLAN_IDENTIFIER を探す ----------
    const dumped = await step("DUMP_PLAN_CACHE_TOPN（一覧の素）", () =>
      executeStatement(conn, "CALL QSYS2.DUMP_PLAN_CACHE_TOPN('QTEMP', 'VPCT', 5, 'RUNTIME')")
    );
    if (dumped) {
      await step("候補列のうち非 NULL のもの（QQRID=3014 の行で）", async () => {
        const sel = ID_CANDIDATES.map(
          (c) => `'${c}=' CONCAT COALESCE(CAST(${c} AS VARCHAR(24)),'-')`
        ).join(" CONCAT ' ' CONCAT ");
        const r = await query(
          conn,
          `SELECT CAST(CAST(QQRID AS VARCHAR(6)) CONCAT ' ' CONCAT ${sel} AS VARCHAR(300)) AS X ` +
            `FROM QTEMP.VPCT WHERE QQRID IN (3014, 3000, 1000) ORDER BY QQRID FETCH FIRST 6 ROWS ONLY`
        );
        for (const row of r.rows) line(`   ${row["X"]}`);
        return `${r.rows.length} 件`;
      });

      // TOPN ダンプ自体が「一覧＋各文の計画詳細」を持っているか（＝2 段目の呼び出しが要るか）
      await step("TOPN ダンプ表の記録種別（詳細まで入っているか）", async () => {
        const r = await query(
          conn,
          "SELECT CAST(CAST(QQRID AS VARCHAR(6)) CONCAT ':' CONCAT CAST(COUNT(*) AS VARCHAR(4)) AS VARCHAR(20)) AS X FROM QTEMP.VPCT GROUP BY QQRID ORDER BY QQRID"
        );
        return r.rows.map((x) => x["X"]).join(" ");
      });
      await step("TOPN ダンプ表に含まれる文の数（QQUCNT の異なり）", async () => {
        const r = await query(conn, "SELECT COUNT(DISTINCT QQUCNT) AS N FROM QTEMP.VPCT");
        return JSON.stringify(r.rows[0]);
      });

      // **「2 行返る＝成功」ではない**ことを、あり得ない id で確かめる（対照実験）
      await step("対照: あり得ない PLAN_IDENTIFIER で DUMP_PLAN_CACHE", async () => {
        await executeStatement(conn, "CALL QSYS2.DUMP_PLAN_CACHE('QTEMP', 'VBOGUS', 999999999999)");
        const n = await query(conn, "SELECT COUNT(*) AS N FROM QTEMP.VBOGUS");
        const k = await query(
          conn,
          "SELECT CAST(CAST(QQRID AS VARCHAR(6)) CONCAT ':' CONCAT CAST(COUNT(*) AS VARCHAR(4)) AS VARCHAR(20)) AS X FROM QTEMP.VBOGUS GROUP BY QQRID ORDER BY QQRID"
        );
        await executeStatement(conn, "DROP TABLE QTEMP.VBOGUS");
        return `行数=${JSON.stringify(n.rows[0])} 種別=${k.rows.map((x) => x["X"]).join(" ")}`;
      });

      // **偶然当たったのを成功と読み違えない**ため、取り出した計画が
      // 「その id の元になった文」かどうかを文テキストで突き合わせる。
      for (const col of ID_CANDIDATES) {
        await step(`${col} を PLAN_IDENTIFIER として DUMP_PLAN_CACHE（文テキストで照合）`, async () => {
          const v = await query(
            conn,
            `SELECT CAST(${col} AS VARCHAR(24)) CONCAT '|' CONCAT COALESCE(SUBSTR(QQ1000, 1, 60), '(文なし)') AS V ` +
              `FROM QTEMP.VPCT WHERE ${col} IS NOT NULL AND ${col} <> 0 AND QQ1000 IS NOT NULL FETCH FIRST 1 ROWS ONLY`
          );
          const raw = String(v.rows[0]?.["V"] ?? "");
          if (!raw) return "(候補値なし)";
          const [id, text] = [raw.slice(0, raw.indexOf("|")), raw.slice(raw.indexOf("|") + 1)];
          await executeStatement(conn, `CALL QSYS2.DUMP_PLAN_CACHE('QTEMP', 'VONE', ${id})`);
          const n = await query(conn, "SELECT COUNT(*) AS N FROM QTEMP.VONE");
          const m = await query(
            conn,
            `SELECT COUNT(*) AS N FROM QTEMP.VONE WHERE QQ1000 LIKE '${text.trim().slice(0, 40).replace(/'/gu, "''")}%'`
          );
          await executeStatement(conn, "DROP TABLE QTEMP.VONE");
          const hit = Number(m.rows[0]?.["N"] ?? 0) > 0;
          return `id=${id} 行数=${JSON.stringify(n.rows[0])} 文一致=${hit ? "YES（この列が計画識別子）" : "NO（別物を引いている）"}`;
        });
      }
    }
  } finally {
    conn.close();
  }
}

main().catch((e) => {
  line(`FATAL: ${String(e)}`);
  process.exit(1);
});
