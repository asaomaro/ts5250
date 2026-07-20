/**
 * DDM 書き込みの実機チェック（手動）。
 *
 * 使い捨ての物理ファイルを作り、DDM で書き、**SQL で読み返して**確かめ、最後に消す。
 * **書いた経路と確かめる経路を分ける**のが要点——同じ経路で確認しても、
 * レコード配置の計算が間違っていることに気づけない。
 *
 * 使い方:
 *   AS400_USER=xxx AS400_PASSWORD=yyy \
 *     npm run ddm -w @as400web/hostserver-check -- --tls [--library MYLIB]
 */
import {
  CommandConnection,
  DbConnection,
  DdmConnection,
  buildDdmRecord,
  buildRecordLayout,
  query,
  As400Error,
  type ColumnLayoutInput
} from "@as400web/core";

const host = process.env["AS400_HOST"] ?? process.env["PUB400_HOST"] ?? "pub400.com";
const user = process.env["AS400_USER"] ?? process.env["PUB400_USER"];
const password = process.env["AS400_PASSWORD"] ?? process.env["PUB400_PASSWORD"];
const useTls = process.argv.includes("--tls");
const libIdx = process.argv.indexOf("--library");
const library = (libIdx >= 0 ? process.argv[libIdx + 1] : undefined) ?? "MYLIB";
const table = "ZZDDM";

function out(s: string): void {
  process.stdout.write(`${s}\n`);
}

if (!user || !password) {
  process.stderr.write("AS400_USER と AS400_PASSWORD を環境変数で指定してください\n");
  process.exit(1);
}

const auth = { host, user, password, tls: useTls };

async function main(): Promise<void> {
  const cmd = await CommandConnection.connect(auth);
  const db = await DbConnection.connect(auth);
  let created = false;
  try {
    // --- 1. 使い捨てのファイルを作る ---
    out(`1. ${library}/${table} を作成`);
    const create = await cmd.run(
      `RUNSQL SQL('CREATE TABLE ${library}.${table} ` +
        `(NAME CHAR(10) NOT NULL, QTY DECIMAL(5, 0) NOT NULL, AMT NUMERIC(7, 2) NOT NULL, ` +
        `SEQ INTEGER NOT NULL, NOTE CHAR(5))') COMMIT(*NONE)`
    );
    if (!create.success) {
      out(`   作成に失敗: ${create.messages.map((m) => `${m.id} ${m.text}`).join(" / ")}`);
      return;
    }
    created = true;

    // --- 2. 列レイアウトを SQL から得る（spec D1） ---
    const meta = await query(
      db,
      `SELECT COLUMN_NAME, DATA_TYPE, LENGTH, NUMERIC_SCALE, IS_NULLABLE ` +
        `FROM QSYS2.SYSCOLUMNS WHERE TABLE_SCHEMA='${library}' AND TABLE_NAME='${table}' ` +
        `ORDER BY ORDINAL_POSITION`
    );
    const columns: ColumnLayoutInput[] = meta.rows.map((r) => ({
      name: String(r["COLUMN_NAME"]).trim(),
      dataType: String(r["DATA_TYPE"]).trim(),
      length: Number(r["LENGTH"]),
      scale: Number(r["NUMERIC_SCALE"] ?? 0),
      nullable: String(r["IS_NULLABLE"]).trim() === "Y"
    }));
    const layout = buildRecordLayout(columns);
    out(
      `2. レイアウト（SQL 由来）: ${layout.fields
        .map((f) => `${f.name}:${f.kind}@${f.offset}+${f.size}`)
        .join(" ")} = ${layout.recordLength} バイト`
    );

    // --- 3. DDM で書く ---
    const ddm = await DdmConnection.connect(auth);
    let file;
    try {
      file = await ddm.open(library, table);
      out(
        `3. open: recordLength=${file.recordLength} increment=${file.recordIncrement} ` +
          `nullMapOffset=${file.nullFieldByteMapOffset}`
      );
      // **ここが仮説の検証点**（spec D1）
      if (file.recordLength !== layout.recordLength) {
        out(
          `   ⚠ 不一致: SQL 由来 ${layout.recordLength} vs ホスト ${file.recordLength}` +
            `（レイアウト計算の前提が崩れている）`
        );
      } else {
        out(`   ✅ SQL 由来のレコード長がホストの申告と一致`);
      }

      const rows: (string | number | null)[][] = [
        ["ALPHA", 12, "34.56", 1, "ok"],
        ["BETA", -7, "-0.01", 2, null], // NULL 指標マップの検証
        ["", 0, "0", 3, ""]
      ];
      for (const values of rows) {
        await ddm.write(file, buildDdmRecord(layout, values));
      }
      out(`4. ${rows.length} 件を書き込み`);
      const messages = await ddm.close(file);
      if (messages.length) {
        out(`   close メッセージ: ${messages.map((m) => `${m.id} ${m.text}`).join(" / ")}`);
      }
    } finally {
      ddm.disconnect();
    }

    // --- 5. SQL で読み返す（別経路の確認） ---
    const back = await query(db, `SELECT * FROM ${library}.${table} ORDER BY SEQ`);
    out(`5. SQL で読み返し: ${back.rows.length} 件`);
    for (const r of back.rows) {
      out(`   ${JSON.stringify(r)}`);
    }
  } catch (e) {
    if (e instanceof As400Error) out(`エラー [${e.code}] ${e.message}`);
    else out(`エラー ${String(e)}`);
    process.exitCode = 1;
  } finally {
    // --- 6. 後片付け ---
    if (created) {
      const drop = await cmd.run(`DLTF FILE(${library}/${table})`);
      out(`6. 後片付け: ${drop.success ? "削除しました" : "削除に失敗"}`);
    }
    db.close();
    cmd.close();
  }
}

void main();
