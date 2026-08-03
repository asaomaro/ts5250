/**
 * DB モニターの**記録種別ごとに、どの列が埋まるか**を実測する。
 *
 *   node --env-file=.env scripts/research-visual-explain-records.mjs           # 実機 (7.3)
 *   node --env-file=.env scripts/research-visual-explain-records.mjs pub400    # PUB400 (7.5)
 *
 * `plan-model.ts` は**中身を実測した種別にしか名前を与えない**方針なので、
 * 名前を増やすにはここで根拠を採る必要がある。
 *
 * 種別を狙って出すために、形の違う SQL を並べて流す。
 * どの形でだけ出たか＋埋まった列の値、の 2 つで意味を絞り込む。
 *
 * **`SELECT *` を使う**——CCSID 65535 の列（`QQJFLD` / `QQBLOB1` / `QXC43`）は
 * 16 進で返るようになった（F8 の修正）。ここはその修正の実機確認も兼ねる。
 */
import { DbConnection, query, executeStatement, SqlError } from "@ts5250/hostserver";

const which = process.argv[2] === "pub400" ? "pub400" : "as400";
const cfg =
  which === "pub400"
    ? { host: process.env["PUB400_HOST"] ?? "pub400.com", user: process.env["PUB400_USER"], password: process.env["PUB400_PASSWORD"], tls: true }
    : { host: process.env["AS400_HOST"], user: process.env["AS400_USER"], password: process.env["AS400_PASSWORD"], tls: false };

const line = (s = "") => process.stdout.write(`${s}\n`);

/** 形の違う SQL。**どの形で出たか**が種別の意味を絞る手がかりになる */
const SHAPES = [
  { tag: "SCAN", sql: "SELECT COUNT(*) AS N FROM QTEMP.RT1 WHERE K > 100" },
  { tag: "JOIN", sql: "SELECT COUNT(*) AS N FROM QTEMP.RT1 A INNER JOIN QTEMP.RT2 B ON A.K = B.K" },
  { tag: "GROUP", sql: "SELECT K, COUNT(*) AS N FROM QTEMP.RT1 GROUP BY K ORDER BY 2 DESC FETCH FIRST 5 ROWS ONLY" },
  { tag: "SORT", sql: "SELECT K, NM FROM QTEMP.RT1 ORDER BY NM FETCH FIRST 5 ROWS ONLY" },
  { tag: "DISTINCT", sql: "SELECT DISTINCT K FROM QTEMP.RT1 FETCH FIRST 5 ROWS ONLY" },
  { tag: "UNION", sql: "SELECT COUNT(*) AS N FROM (SELECT K FROM QTEMP.RT1 UNION SELECT K FROM QTEMP.RT2) X" },
  { tag: "SUBQ", sql: "SELECT COUNT(*) AS N FROM QTEMP.RT1 WHERE K IN (SELECT K FROM QTEMP.RT2)" },
  { tag: "IDXUSE", sql: "SELECT COUNT(*) AS N FROM QSYS2.SYSCOLUMNS WHERE TABLE_SCHEMA = 'QSYS2'" },
  { tag: "HOSTVAR", sql: "SELECT COUNT(*) AS N FROM QTEMP.RT1 WHERE NM = 'ZZZ'" }
];

/** 値が「入っている」とみなすか（空白詰め・0・16 進の 0 埋めは除く） */
function meaningful(v) {
  if (v === null || v === undefined) return false;
  if (typeof v === "number") return v !== 0;
  if (typeof v === "bigint") return v !== 0n;
  if (typeof v === "string") {
    const s = v.trim();
    if (s === "" || s === "0") return false;
    // CCSID 65535 の列は 16 進で来る。全部 0 なら中身なし
    if (/^0+$/u.test(s)) return false;
    return true;
  }
  return true;
}

async function main() {
  line(`### ${which} host=${cfg.host}`);
  const conn = await DbConnection.connect(cfg);
  try {
    await executeStatement(
      conn,
      "CREATE TABLE QTEMP.RT1 AS (SELECT CAST(ORDINAL_POSITION AS INTEGER) AS K, CAST(COLUMN_NAME AS CHAR(30)) AS NM FROM QSYS2.SYSCOLUMNS WHERE TABLE_SCHEMA = 'QSYS2') WITH DATA"
    );
    await executeStatement(
      conn,
      "CREATE TABLE QTEMP.RT2 AS (SELECT CAST(ORDINAL_POSITION AS INTEGER) AS K, CAST(TABLE_NAME AS CHAR(30)) AS TN FROM QSYS2.SYSCOLUMNS WHERE TABLE_SCHEMA = 'QSYS') WITH DATA"
    );
    line("検証表 QTEMP.RT1 / RT2 を作成");

    await executeStatement(conn, "CALL QSYS2.QCMDEXC('STRDBMON OUTFILE(QTEMP/RREC) JOB(*) TYPE(*DETAIL)')");
    for (const s of SHAPES) {
      try {
        await query(conn, s.sql);
      } catch (e) {
        line(`  ${s.tag}: 実行できず ${e instanceof SqlError ? e.sqlCode : String(e).slice(0, 60)}`);
      }
    }
    await executeStatement(conn, "CALL QSYS2.QCMDEXC('ENDDBMON JOB(*)')");

    // **SELECT * が通るか**（F8 の修正の実機確認も兼ねる）
    let all;
    try {
      all = await query(conn, "SELECT * FROM QTEMP.RREC");
      line(`\nSELECT * が通った: ${all.rows.length} 行 / ${all.columns.length} 列（F8 の修正が効いている）`);
    } catch (e) {
      line(`\nSELECT * が失敗: ${String(e).slice(0, 200)}`);
      return;
    }

    // 文テキスト → 形の対応（QQUCNT ごと）
    const shapeOf = new Map();
    for (const r of all.rows) {
      const text = String(r["QQ1000"] ?? "");
      for (const s of SHAPES) {
        const key = s.sql.slice(7, 45);
        if (text.includes(key)) shapeOf.set(r["QQUCNT"], s.tag);
      }
    }

    // 種別ごとに: 出た形 / 埋まった列
    const byRid = new Map();
    for (const r of all.rows) {
      const rid = Number(r["QQRID"]);
      const e = byRid.get(rid) ?? { count: 0, shapes: new Set(), cols: new Map() };
      e.count += 1;
      const tag = shapeOf.get(r["QQUCNT"]);
      if (tag) e.shapes.add(tag);
      for (const [k, v] of Object.entries(r)) {
        if (k === "QQRID" || !meaningful(v)) continue;
        const seen = e.cols.get(k) ?? new Set();
        if (seen.size < 2) seen.add(String(v).trim().slice(0, 40));
        e.cols.set(k, seen);
      }
      byRid.set(rid, e);
    }

    line("\n=== 記録種別ごとの実測 ===");
    for (const rid of [...byRid.keys()].sort((a, b) => a - b)) {
      const e = byRid.get(rid);
      line(`\n[QQRID ${rid}] ${e.count} 件  出た形: ${[...e.shapes].join(", ") || "(特定できず)"}`);
      // 記録種別の意味に効きそうな列を優先して出す
      const priority = ["QQRCOD", "QQC11", "QQC12", "QQC13", "QQC14", "QQC15", "QQC16", "QQC18", "QQC21", "QQC22", "QQC23", "QVQTBL", "QVINAM", "QQIDXA", "QQIDXD", "QQC101", "QQC102", "QQC103", "QQC104"];
      const shown = [...e.cols.entries()].sort((a, b) => {
        const ia = priority.indexOf(a[0]);
        const ib = priority.indexOf(b[0]);
        return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
      });
      for (const [col, vals] of shown.slice(0, 22)) {
        line(`   ${col.padEnd(10)} = ${[...vals].join(" | ")}`);
      }
      if (shown.length > 22) line(`   …他 ${shown.length - 22} 列`);
    }
  } finally {
    try {
      await executeStatement(conn, "DROP TABLE QTEMP.RREC");
    } catch {
      /* 片付け失敗は無視 */
    }
    conn.close();
  }
}

main().catch((e) => {
  line(`FATAL: ${String(e)}`);
  process.exit(1);
});
