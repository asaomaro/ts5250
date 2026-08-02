// 実機で**日付・時刻のシステム値**を引く経路を確かめる。
//
// 問い（`.aidev/backlog/input-assist.md`）:
//   `2/2/2` という署名を見ても **YMD / MDY / DMY は決まらない**。EDTCDE の `Y` は
//   システム値 **QDATFMT** に従うため、同じ画面でも設定次第で意味が変わる。
//   区切りは QDATSEP・QTIMSEP。**ビュー名は実機で要確認**（backlog に「はず」と書かれている）。
//
// ここで確かめること:
//   1. `QSYS2.SYSTEM_VALUE_INFO` は実在するか（名前が違うなら候補を順に試す）
//   2. `QDATFMT` / `QDATSEP` / `QTIMSEP` が引けるか。値はどの列に入るか
//
// 実行: AS400_PASSWORD=... node scripts/research-sysval.mjs
import { readFileSync } from "node:fs";
import { DbConnection, query } from "@ts5250/tn5250";

const log = (s) => process.stdout.write(s + "\n");
const conns = JSON.parse(readFileSync("connections.json", "utf8"));
const sys = conns.systems.find((s) => s.name === "実機");
const password = process.env.AS400_PASSWORD;
if (!password) {
  log("AS400_PASSWORD が未設定です");
  process.exit(1);
}

/** 候補を順に試す。**推測を 1 つに絞らない**（名前が違えば次を試す） */
const CANDIDATES = [
  "SELECT SYSTEM_VALUE_NAME, CURRENT_NUMERIC_VALUE, CURRENT_CHARACTER_VALUE FROM QSYS2.SYSTEM_VALUE_INFO WHERE SYSTEM_VALUE_NAME IN ('QDATFMT','QDATSEP','QTIMSEP')",
  "SELECT * FROM QSYS2.SYSTEM_VALUE_INFO WHERE SYSTEM_VALUE_NAME = 'QDATFMT'",
  "SELECT SYSTEM_VALUE_NAME, CURRENT_CHARACTER_VALUE FROM QSYS2.SYSTEM_VALUE_INFO FETCH FIRST 5 ROWS ONLY"
];

let conn;
let failed = 0;
try {
  conn = await DbConnection.connect({
    host: sys.host,
    user: sys.signon.user,
    password,
    ...(sys.tls !== undefined ? { tls: sys.tls } : {})
  });
  log(`接続 OK（${sys.host}）\n`);

  for (const sql of CANDIDATES) {
    log("---- " + sql.slice(0, 110));
    try {
      const r = await query(conn, sql);
      log("列: " + r.columns.map((c) => `${c.name}(${c.type})`).join(", "));
      for (const row of r.rows) log("  " + JSON.stringify(row));
      if (r.rows.length === 0) log("  （0 行）");
    } catch (e) {
      log("  ERROR: " + (e instanceof Error ? e.message : String(e)));
      failed++;
    }
    log("");
  }
} catch (e) {
  log("接続 ERROR: " + (e instanceof Error ? e.message : String(e)));
  failed++;
} finally {
  conn?.close?.();
}
process.exit(failed >= CANDIDATES.length ? 1 : 0);
