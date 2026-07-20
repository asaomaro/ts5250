/**
 * CSV 取り込みの実機チェック（手動）。
 *
 * `ddm.ts` が **DDM 層**（バイト配置・バッチ）を確かめるのに対し、こちらは
 * **取り込みの経路まるごと**（列メタデータ取得 → 事前検査 → バッチ書き込み）を確かめる。
 * サーバーの `uploadRows` をそのまま呼ぶので、HTTP と MCP が通る道と同一である。
 *
 * 確かめるのは requirement の受け入れ基準:
 *   (a) CSV から投入し、**SQL で読み返して**一致する（書いた経路と確かめる経路を分ける）
 *   (b) 日本語が CCSID 5035/930 の列に書け、既知の基準行と一致する
 *   (c) CCSID 273 の列に日本語を入れた CSV は **1 行も書かずに**拒否される
 *   (d) 100 行がバッチでまとまり、往復数が件数に比例しない
 *
 * 使い方（`.env` に PUB400_USER / PUB400_PASSWORD がある前提）:
 *   node --env-file=../../.env dist/upload.js --tls
 */
import "./log-init.js";
import { CommandConnection, DbConnection, query, As400Error, type ConnectOptions } from "@as400web/core";
import { uploadCsv, uploadRows } from "@as400web/server";

const host = process.env["AS400_HOST"] ?? process.env["PUB400_HOST"] ?? "pub400.com";
const user = process.env["AS400_USER"] ?? process.env["PUB400_USER"];
const password = process.env["AS400_PASSWORD"] ?? process.env["PUB400_PASSWORD"];
const useTls = process.argv.includes("--tls");
const library = "MYLIB";

function out(s: string): void {
  process.stdout.write(`${s}\n`);
}

if (!user || !password) {
  process.stderr.write("AS400_USER / AS400_PASSWORD（または PUB400_*）が必要です\n");
  process.exit(1);
}

const opts = { host, user, password, tls: useTls } as unknown as ConnectOptions;

/** 一時表を作る。**使い終わったら消す**（実機に残さない） */
async function withTable(
  cmd: CommandConnection,
  name: string,
  ddl: string,
  body: () => Promise<void>
): Promise<void> {
  const create = await cmd.run(`RUNSQL SQL('CREATE TABLE ${library}.${name} ${ddl}') COMMIT(*NONE)`);
  const ok = create.messages.every((m) => !m.id.startsWith("SQL7") || m.id === "SQL7905");
  if (!create.success && !ok) {
    out(`   表を作れませんでした: ${create.messages.map((m) => m.id).join(" ")}`);
    return;
  }
  try {
    await body();
  } catch (e) {
    // **1 つ失敗しても次の項目へ進む**——受け入れ基準ごとの成否を一度に把握したいため
    out(`   ❌ ${e instanceof As400Error ? `[${e.code}] ${e.message}` : String(e)}`);
  } finally {
    await cmd.run(`DLTF FILE(${library}/${name})`);
  }
}

async function main(): Promise<void> {
  const cmd = await CommandConnection.connect({ host, user: user!, password: password!, tls: useTls });
  const db = await DbConnection.connect({ host, user: user!, password: password!, tls: useTls });
  try {
    // ---- (a) 基本の往復 ----
    out("=== (a) CSV から投入 → SQL で読み返す ===");
    await withTable(cmd, "ZZUP1", "(ID SMALLINT NOT NULL, NAME CHAR(10), AMT DECIMAL(7, 2))", async () => {
      const csv = "ID,NAME,AMT\n1,alpha,12.34\n2,beta,-0.50\n3,,0";
      const res = await uploadCsv({ opts, library, file: "ZZUP1", csv, emptyAsNull: true });
      out(`   ${JSON.stringify(res)}`);
      const back = await query(db, `SELECT * FROM ${library}.ZZUP1 ORDER BY ID`);
      for (const r of back.rows) out(`   ${JSON.stringify(r)}`);
    });

    // ---- (b) 日本語 ----
    out("=== (b) 日本語を CCSID 5035 / 930 の列へ ===");
    await withTable(
      cmd,
      "ZZUP2",
      "(ID SMALLINT NOT NULL, C_JP CHAR(20) CCSID 5035, C_JP2 CHAR(20) CCSID 930)",
      async () => {
        const res = await uploadRows({
          opts,
          library,
          file: "ZZUP2",
          header: ["ID", "C_JP", "C_JP2"],
          rows: [
            ["1", "日本語", "パス"],
            ["2", "あいうえお", "カナ"]
          ]
        });
        out(`   ${JSON.stringify(res)}`);
        const back = await query(db, `SELECT ID, C_JP, C_JP2, HEX(C_JP) AS H FROM ${library}.ZZUP2 ORDER BY ID`);
        for (const r of back.rows) out(`   ${JSON.stringify(r)}`);
        // **基準行との突き合わせ**: research で UX'' リテラル経由で仕込んだ既知の行
        const ref = await query(db, `SELECT HEX(C_JP) AS H FROM ${library}.CSVUPJP WHERE ID = 2`);
        const mine = await query(db, `SELECT HEX(C_JP) AS H FROM ${library}.ZZUP2 WHERE ID = 1`);
        const same = String(ref.rows[0]?.["H"] ?? "") === String(mine.rows[0]?.["H"] ?? "");
        out(`   基準行（CSVUPJP ID=2 の「日本語」）とバイト一致: ${same ? "✅ 一致" : "❌ 不一致"}`);
        if (!same) {
          out(`     基準 ${String(ref.rows[0]?.["H"])}`);
          out(`     今回 ${String(mine.rows[0]?.["H"])}`);
        }
      }
    );

    // ---- (c) 書けない文字は 1 行も書かずに拒否 ----
    out("=== (c) CCSID 273 の列に日本語 → 1 行も書かない ===");
    await withTable(cmd, "ZZUP3", "(ID SMALLINT NOT NULL, S CHAR(10) CCSID 273)", async () => {
      const res = await uploadCsv({ opts, library, file: "ZZUP3", csv: "ID,S\n1,ok\n2,日本語" });
      out(`   ${JSON.stringify(res)}`);
      const back = await query(db, `SELECT COUNT(*) AS N FROM ${library}.ZZUP3`);
      out(`   表の行数: ${String(back.rows[0]?.["N"])}（0 であること）`);
    });

    // ---- (d) 100 行の性能 ----
    out("=== (d) 100 行（バッチの効果）===");
    await withTable(cmd, "ZZUP4", "(ID SMALLINT NOT NULL, S CHAR(10))", async () => {
      const rows = Array.from({ length: 100 }, (_, i) => [String(i + 1), `row${i + 1}`]);
      const started = Date.now();
      const res = await uploadRows({ opts, library, file: "ZZUP4", header: ["ID", "S"], rows });
      out(`   ${JSON.stringify(res)} / 実測 ${Date.now() - started}ms（接続を含む）`);
      const back = await query(db, `SELECT COUNT(*) AS N FROM ${library}.ZZUP4`);
      out(`   表の行数: ${String(back.rows[0]?.["N"])}（100 であること）`);
      out(`   往復数: ${Math.ceil(100 / (res.ok ? res.batchSize : 1))}（1 件 1 往復なら 100 往復）`);
    });
  } catch (e) {
    if (e instanceof As400Error) out(`エラー [${e.code}] ${e.message}`);
    else out(`エラー ${String(e)}`);
    process.exitCode = 1;
  } finally {
    db.close();
    cmd.close();
  }
}

void main();
