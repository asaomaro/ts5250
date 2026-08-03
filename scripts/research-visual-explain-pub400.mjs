/**
 * Visual Explain 調査（PUB400 / IBM i 7.5・共用機・非特権想定）。
 *
 * 実機（7.3・全特権）で確かめた経路が、版数と権限の違う機でどうなるかを測る。
 *
 * ⚠ 共用機なので **他利用者の SQL 文は表示しない**。権限判定（成否と SQLCODE）と件数だけを見る。
 */
import { DbConnection, query, executeStatement, SqlError } from "@ts5250/hostserver";

const host = process.env["PUB400_HOST"] ?? "pub400.com";
const user = process.env["PUB400_USER"];
const password = process.env["PUB400_PASSWORD"];

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

async function main() {
  line(`host=${host} tls=true`);
  const conn = await DbConnection.connect({ host, user, password, tls: true });
  try {
    await step("版数（累積 PTF 群。末尾 3 桁が版数）", async () => {
      const r = await query(
        conn,
        "SELECT CAST(PTF_GROUP_NAME CONCAT ' ' CONCAT COALESCE(PTF_GROUP_DESCRIPTION,'') AS VARCHAR(80)) AS X FROM QSYS2.GROUP_PTF_INFO WHERE PTF_GROUP_DESCRIPTION LIKE '%CUMULATIVE%'"
      );
      return r.rows.map((x) => x["X"]).join(" / ") || "(該当なし)";
    });

    await step("版数（ENV_SYS_INFO。7.3 には無かった）", async () => {
      const r = await query(conn, "SELECT CAST(OS_VERSION CONCAT '.' CONCAT OS_RELEASE AS VARCHAR(20)) AS X FROM QSYS2.ENV_SYS_INFO");
      return JSON.stringify(r.rows[0]);
    });

    await step("現ユーザーの特殊権限", async () => {
      const r = await query(
        conn,
        "SELECT CAST(AUTHORIZATION_NAME CONCAT ' | ' CONCAT COALESCE(SPECIAL_AUTHORITIES,'(なし)') AS VARCHAR(200)) AS X FROM QSYS2.USER_INFO WHERE AUTHORIZATION_NAME = CURRENT_USER"
      );
      return JSON.stringify(r.rows[0]);
    });

    await step("F1: プランキャッシュ系サービスが 7.5 にも在るか", async () => {
      const r = await query(
        conn,
        "SELECT CAST(ROUTINE_NAME AS VARCHAR(40)) AS X FROM QSYS2.SYSROUTINES WHERE ROUTINE_SCHEMA = 'QSYS2' AND ROUTINE_NAME IN ('DUMP_PLAN_CACHE','DUMP_PLAN_CACHE_TOPN','DUMP_PLAN_CACHE_PROPERTIES','LIST_EXPLAINABLE_DETAILED','PROCESS_DETAILED_MONITOR') GROUP BY ROUTINE_NAME ORDER BY 1"
      );
      return r.rows.map((x) => x["X"]).join(", ") || "(なし)";
    });

    await step("F1b: DUMP_PLAN_CACHE の引数が 7.3 と同じか", async () => {
      const r = await query(
        conn,
        "SELECT CAST(COALESCE(p.PARAMETER_NAME,'?') CONCAT ':' CONCAT p.DATA_TYPE AS VARCHAR(60)) AS X FROM QSYS2.SYSPARMS p JOIN QSYS2.SYSROUTINES r ON r.SPECIFIC_SCHEMA = p.SPECIFIC_SCHEMA AND r.SPECIFIC_NAME = p.SPECIFIC_NAME WHERE r.ROUTINE_SCHEMA = 'QSYS2' AND r.ROUTINE_NAME = 'DUMP_PLAN_CACHE' ORDER BY p.ORDINAL_POSITION"
      );
      return r.rows.map((x) => x["X"]).join(", ") || "(なし)";
    });

    // --- ここからが本命: 非特権でも自ジョブ DB モニターが使えるか ---
    const marker = `VEP400_${Date.now()}`;
    const monOk = await step("F5: QCMDEXC で自ジョブに STRDBMON", () =>
      executeStatement(conn, "CALL QSYS2.QCMDEXC('STRDBMON OUTFILE(QTEMP/VEP) JOB(*) TYPE(*DETAIL)')")
    );
    if (monOk) {
      await step(`監視下で文を実行 ${marker}`, async () => {
        const r = await query(
          conn,
          `SELECT COUNT(*) AS N FROM QSYS2.SYSCOLUMNS WHERE TABLE_SCHEMA = 'QSYS2' AND '${marker}' = '${marker}'`
        );
        return JSON.stringify(r.rows[0]);
      });
      await step("ENDDBMON", () => executeStatement(conn, "CALL QSYS2.QCMDEXC('ENDDBMON JOB(*)')"));
      await step("自分の文の計画記録が採れたか", async () => {
        const r = await query(
          conn,
          `SELECT CAST(QQRID AS VARCHAR(6)) CONCAT ' x' CONCAT CAST(COUNT(*) AS VARCHAR(4)) AS X FROM QTEMP.VEP WHERE QQUCNT IN (SELECT DISTINCT QQUCNT FROM QTEMP.VEP WHERE QQ1000 LIKE '%${marker}%') GROUP BY QQRID ORDER BY QQRID`
        );
        return r.rows.map((x) => x["X"]).join(" ") || "(なし)";
      });
      await step("計画ノードの中身（自分の文のみ）", async () => {
        const r = await query(
          conn,
          `SELECT CAST(CAST(QQRID AS VARCHAR(6)) CONCAT ' tbl=' CONCAT COALESCE(QVQLIB,'-') CONCAT '/' CONCAT COALESCE(QVQTBL,'-') CONCAT ' idx=' CONCAT COALESCE(QVINAM,'-') CONCAT ' rows=' CONCAT COALESCE(CAST(QQTOTR AS VARCHAR(12)),'-') CONCAT ' idxadv=' CONCAT COALESCE(QQIDXA,'-') AS VARCHAR(160)) AS X FROM QTEMP.VEP WHERE QQUCNT IN (SELECT DISTINCT QQUCNT FROM QTEMP.VEP WHERE QQ1000 LIKE '%${marker}%') AND QQRID IN (3000,3001,3002,3020) ORDER BY QQRID`
        );
        for (const row of r.rows) line(`   ${row["X"]}`);
        return `${r.rows.length} 件`;
      });
      await step("F8: CCSID 65535 列（SELECT * が落ちるか）", async () => {
        const meta = await query(conn, "SELECT * FROM QTEMP.VEP WHERE 1 = 0");
        const bin = meta.columns.filter((c) => c.ccsid === 65535);
        return `列数=${meta.columns.length} / CCSID65535=${bin.map((c) => c.name).join(",") || "なし"}`;
      });
    }

    // --- プランキャッシュ（システム全体）。共用機で拒否されるかを見る。文テキストは出さない ---
    await step("F4: DUMP_PLAN_CACHE_TOPN（特権が要る想定。拒否のされ方を見る）", () =>
      executeStatement(conn, "CALL QSYS2.DUMP_PLAN_CACHE_TOPN('QTEMP', 'PCT400', 5, 'RUNTIME')")
    );
    await step("同・作られた表の行数だけ（文テキストは表示しない）", async () => {
      const r = await query(conn, "SELECT COUNT(*) AS N FROM QTEMP.PCT400");
      return JSON.stringify(r.rows[0]);
    });
    await step("F10: SYSIXADV が読めるか（件数のみ）", async () => {
      const r = await query(conn, "SELECT COUNT(*) AS N FROM QSYS2.SYSIXADV");
      return JSON.stringify(r.rows[0]);
    });
  } finally {
    conn.close();
  }
}

main().catch((e) => {
  line(`FATAL: ${String(e)}`);
  process.exit(1);
});
