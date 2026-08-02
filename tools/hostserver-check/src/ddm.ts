/**
 * DDM 書き込みの実機チェック（手動）。
 *
 * 使い捨ての物理ファイルを作り、DDM で書き、**SQL で読み返して**確かめ、最後に消す。
 * **書いた経路と確かめる経路を分ける**のが要点——同じ経路で確認しても、
 * レコード配置の計算が間違っていることに気づけない。
 *
 * 使い方:
 *   AS400_USER=xxx AS400_PASSWORD=yyy \
 *     npm run ddm -w @ts5250/hostserver-check -- --tls [--library MYLIB]
 */
import "./log-init.js";
import { As400Error } from "@ts5250/base";
import { CommandConnection, DbConnection, DdmConnection, buildDdmRecord, buildRecordLayout, fetchColumnLayout, query, type ColumnLayoutInput } from "@ts5250/hostserver";

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
    // 問い合わせは core（`fetchColumnLayout`）に一本化した。
    // **ここに 2 つ目の SYSCOLUMNS クエリを置かない**——列や順序が食い違う元になる
    const columns: ColumnLayoutInput[] = await fetchColumnLayout(db, library, table);
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
      // **バッチ書き込みの実機確認**（research F1/F2）。
      // 1 件 1 往復だと実機は 4〜7 秒/往復なので、往復数が件数でなくバッチ数に
      // なっていることを実測で示す
      out(`4. バッチ: 実効 ${file.effectiveBatchSize} 件/往復（increment=${file.recordIncrement}）`);
      const started = Date.now();
      const res = await ddm.writeAll(file, rows.map((values) => buildDdmRecord(layout, values)));
      const trips = Math.ceil(rows.length / file.effectiveBatchSize);
      out(
        `   ${res.committedRows}/${rows.length} 件を ${trips} 往復で書き込み ` +
          `(${Date.now() - started}ms)`
      );
      if (res.uncertainRange) {
        out(
          `   ⚠ ${res.uncertainRange.from}〜${res.uncertainRange.to} 行目は確定不明: ${res.error ?? ""}`
        );
      }
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
