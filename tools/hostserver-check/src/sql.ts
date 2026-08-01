/**
 * 実機の IBM i に SQL を投げて結果を確認する手動チェック。
 *
 * 使い方:
 *   AS400_USER=xxx AS400_PASSWORD=yyy \
 *     npm run sql -w @as400web/hostserver-check -- --tls "SELECT * FROM MYLIB.SQLTYPES"
 */
import "./log-init.js";
import { As400Error } from "@as400web/base";
import { DbConnection, query, SqlError } from "@as400web/hostserver";

const host = process.env["AS400_HOST"] ?? process.env["PUB400_HOST"] ?? "pub400.com";
const user = process.env["AS400_USER"] ?? process.env["PUB400_USER"];
const password = process.env["AS400_PASSWORD"] ?? process.env["PUB400_PASSWORD"];
const useTls = process.argv.includes("--tls");
const sql = process.argv.slice(2).find((a) => !a.startsWith("--")) ?? "SELECT * FROM MYLIB.SQLTYPES";

function fail(message: string): never {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}
if (!user || !password) fail("AS400_USER / AS400_PASSWORD を環境変数で指定してください");

async function main(): Promise<void> {
  process.stdout.write(`host=${host} tls=${useTls}\nsql=${sql}\n\n`);
  const conn = await DbConnection.connect({
    host,
    user: user as string,
    password: password as string,
    tls: useTls
  });
  try {
    const r = await query(conn, sql);
    process.stdout.write("=== 列 ===\n");
    for (const c of r.columns) {
      process.stdout.write(
        `  ${c.name.padEnd(10)} ${c.typeName.padEnd(12)} len=${String(c.length).padStart(3)} ` +
          `scale=${c.scale} prec=${c.precision} ccsid=${String(c.ccsid).padStart(5)} ` +
          `null=${c.nullable ? "Y" : "N"} js=${c.jsType}\n`
      );
    }
    process.stdout.write(`\n=== ${r.rows.length} 行 ===\n`);
    for (const row of r.rows) {
      for (const [k, v] of Object.entries(row)) {
        const shown = v === null ? "(null)" : typeof v === "bigint" ? `${v}n` : JSON.stringify(v);
        process.stdout.write(`  ${k.padEnd(10)} = ${shown}  [${typeof v}]\n`);
      }
      process.stdout.write("  ---\n");
    }
  } finally {
    conn.close();
  }
}

main().catch((e: unknown) => {
  if (e instanceof SqlError) fail(`SQL エラー: SQLCODE=${e.sqlCode} SQLSTATE=${e.sqlState}\n${e.message}`);
  if (e instanceof As400Error) fail(`[${e.code}] ${e.message}`);
  fail(`予期しないエラー: ${String(e)}\n${e instanceof Error ? e.stack : ""}`);
});
