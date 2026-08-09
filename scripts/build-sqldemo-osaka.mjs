// SR-OSAKA の ASAOLIB に **SQL 画面の検証用オブジェクト**を作って残す。
//
// 「SQL 画面から SELECT 以外もできる」ことを人が確かめるための一式で、
// **消さずに残す**のが目的（利用者の指示）。作るもの:
//
//   SQLDEMO     表（日本語を含む 4 行。DECIMAL・VARCHAR・INT）
//   SQLDEMOLOG  トリガーの書き込み先
//   SQLDEMOV    ビュー
//   SQLDEMOP    手続き（IN ＋ OUT）           → `CALL ASAOLIB.SQLDEMOP(1, 1.50, ?)`
//   SQLDEMORS   手続き（結果セット 1 個）      → `CALL ASAOLIB.SQLDEMORS()`
//   SQLDEMORS2  手続き（結果セット 2 個）      → 「2 個のうち 1 個目」の表示を見る
//   SQLDEMOF    関数（スカラー）              → `SELECT ASAOLIB.SQLDEMOF(ID) FROM …`
//   SQLDEMOPICK 手続き（SQLDEMORS2 の**2 個目**の結果セットを返す）
//   SQLDEMOTR   トリガー（AFTER INSERT）
//
// **DDL はこのファイルが持ち物**。SQL 画面へそのまま貼っても通る形で書いてある
// （`BEGIN … END` の中の `;` で切らないので、複合文をコピーして実行できる）。
//
// ⚠ これは検証用の資産であって、テストではない。**毎回作り直す**（先に DROP する）ので、
// 中身を書き換えて残したい場合は名前を変えること。
//
// 実行:
//   node --env-file=.env scripts/build-sqldemo-osaka.mjs
//   AS400_HOST=... AS400_USER=... AS400_PASSWORD=... node scripts/build-sqldemo-osaka.mjs
import { readFileSync } from "node:fs";
import { DbConnection, executeStatement, queryLimited } from "@ts5250/hostserver";
import { SecretCrypto } from "../packages/server/dist/secret-crypto.js";

const out = (s) => process.stdout.write(s + "\n");
const err = (s) => process.stderr.write(s + "\n");
const LIB = process.env.AS400_LIB ?? "ASAOLIB";

/**
 * 接続先。環境変数が揃っていればそれを使い、無ければ設定ファイルから読む。
 * **どちらか片方に決め打たない**——この機械では `connections.json` が空で
 * `profiles.local.json` に SR-OSAKA が入っている、という並びもある。
 */
function target() {
  if (process.env.AS400_HOST && process.env.AS400_USER && process.env.AS400_PASSWORD) {
    return { host: process.env.AS400_HOST, user: process.env.AS400_USER, password: process.env.AS400_PASSWORD };
  }
  for (const file of ["connections.json", "profiles.local.json"]) {
    let cfg;
    try {
      cfg = JSON.parse(readFileSync(file, "utf8"));
    } catch {
      continue;
    }
    const sys = (cfg.systems ?? []).find((s) => s.name === "SR-OSAKA");
    if (!sys?.signon?.passwordEnc) continue;
    const crypto = SecretCrypto.fromEnv();
    if (!crypto) break;
    return { host: sys.host, user: sys.signon.user, password: crypto.decrypt(sys.signon.passwordEnc) };
  }
  err("接続先が分かりません。AS400_HOST / AS400_USER / AS400_PASSWORD を渡すか、");
  err("connections.json か profiles.local.json に SR-OSAKA を置いて --env-file=.env で実行してください。");
  process.exit(2);
}

/** 先に消すもの（**依存の逆順**。表を先に消すと手続きが道連れになる） */
const DROPS = [
  `DROP TRIGGER ${LIB}.SQLDEMOTR`,
  `DROP VIEW ${LIB}.SQLDEMOV`,
  `DROP FUNCTION ${LIB}.SQLDEMOF`,
  `DROP PROCEDURE ${LIB}.SQLDEMOP`,
  `DROP PROCEDURE ${LIB}.SQLDEMORS`,
  `DROP PROCEDURE ${LIB}.SQLDEMORS2`,
  `DROP PROCEDURE ${LIB}.SQLDEMOPICK`,
  `DROP TABLE ${LIB}.SQLDEMOLOG`,
  `DROP TABLE ${LIB}.SQLDEMO`
];

/** 作るもの。**SQL 画面へそのまま貼れる形**で書く（複合文もこのまま通る） */
const DDL = [
  [
    "表",
    `CREATE TABLE ${LIB}.SQLDEMO (
       ID   INT           NOT NULL PRIMARY KEY,
       NAME VARCHAR(30),
       QTY  DECIMAL(7,2)  DEFAULT 0
     )`
  ],
  ["表に注記", `LABEL ON TABLE ${LIB}.SQLDEMO IS 'SQL 画面の検証用'`],
  ["索引", `CREATE INDEX ${LIB}.SQLDEMOIX ON ${LIB}.SQLDEMO (NAME)`],
  ["トリガーの書き込み先", `CREATE TABLE ${LIB}.SQLDEMOLOG (AT TIMESTAMP, ID INT)`],
  // **行より先にトリガーを作る。** あとから作ると記録が空のままで、
  // 効いているのか作り忘れたのか画面から見分けられない
  [
    "トリガー",
    `CREATE TRIGGER ${LIB}.SQLDEMOTR AFTER INSERT ON ${LIB}.SQLDEMO
       REFERENCING NEW AS N
       FOR EACH ROW MODE DB2SQL
     BEGIN
       INSERT INTO ${LIB}.SQLDEMOLOG VALUES (CURRENT TIMESTAMP, N.ID);
     END`
  ],
  [
    "行",
    `INSERT INTO ${LIB}.SQLDEMO (ID, NAME, QTY) VALUES
       (1, '大阪支店', 10.50),
       (2, '東京支店', 20.00),
       (3, '名古屋支店', 30.00),
       (4, '福岡支店', 40.00)`
  ],
  ["ビュー", `CREATE VIEW ${LIB}.SQLDEMOV AS SELECT ID, NAME FROM ${LIB}.SQLDEMO WHERE QTY > 0`],
  [
    "手続き（IN ＋ OUT）",
    `CREATE PROCEDURE ${LIB}.SQLDEMOP (IN P_ID INT, IN P_ADD DECIMAL(7,2), OUT P_QTY DECIMAL(7,2))
     LANGUAGE SQL
     BEGIN
       DECLARE V_N INT DEFAULT 0;
       DECLARE C1 CURSOR FOR SELECT COUNT(*) FROM ${LIB}.SQLDEMO;
       DECLARE CONTINUE HANDLER FOR SQLEXCEPTION SET P_QTY = -1;
       OPEN C1;
       FETCH C1 INTO V_N;
       CLOSE C1;
       IF V_N > 0 THEN
         UPDATE ${LIB}.SQLDEMO
            SET QTY = CASE WHEN QTY IS NULL THEN P_ADD ELSE QTY + P_ADD END
          WHERE ID = P_ID;
       END IF;
       SET P_QTY = (SELECT QTY FROM ${LIB}.SQLDEMO WHERE ID = P_ID);
     END`
  ],
  [
    "手続き（結果セット 1 個）",
    `CREATE PROCEDURE ${LIB}.SQLDEMORS () LANGUAGE SQL DYNAMIC RESULT SETS 1
     BEGIN
       DECLARE C1 CURSOR WITH RETURN FOR SELECT ID, NAME, QTY FROM ${LIB}.SQLDEMO ORDER BY ID;
       OPEN C1;
     END`
  ],
  [
    "手続き（結果セット 2 個）",
    `CREATE PROCEDURE ${LIB}.SQLDEMORS2 () LANGUAGE SQL DYNAMIC RESULT SETS 2
     BEGIN
       DECLARE C1 CURSOR WITH RETURN FOR SELECT ID, NAME FROM ${LIB}.SQLDEMO ORDER BY ID;
       DECLARE C2 CURSOR WITH RETURN FOR SELECT COUNT(*) AS N FROM ${LIB}.SQLDEMO;
       OPEN C1;
       OPEN C2;
     END`
  ],
  /**
   * **2 個目以降の結果セットを見るための包み。**
   *
   * ホストサーバー経由では、手続きが返す結果セットは **1 個目しか開けない**
   * （2 個目を開こうとすると `SQLCODE -517`。カーソル名の変え方・開く順・
   * 文名を分ける・実行し直す…と 10 通り試して SR-OSAKA で確認した）。
   *
   * SQL の側には道がある——`ASSOCIATE RESULT SET LOCATORS` でロケーターを受け取れば、
   * 何個目でも読める。ただし**読んだ行をクライアントへ返すには器が要る**ので、
   * 一時表へ写して、それを `WITH RETURN` で返す。**列の形が分かっている手続き専用**の
   * 書き方になる（汎用にはできない。だから画面の機能にはせず、雛形として置く）。
   */
  [
    "手続き（SQLDEMORS2 の 2 個目を返す）",
    `CREATE PROCEDURE ${LIB}.SQLDEMOPICK () LANGUAGE SQL DYNAMIC RESULT SETS 1
     BEGIN
       DECLARE L1 RESULT_SET_LOCATOR VARYING;
       DECLARE L2 RESULT_SET_LOCATOR VARYING;
       DECLARE V INT;
       DECLARE DONE INT DEFAULT 0;
       DECLARE OUT1 CURSOR WITH RETURN FOR SELECT N FROM SESSION.RS2PICK;
       DECLARE CONTINUE HANDLER FOR NOT FOUND SET DONE = 1;
       DECLARE GLOBAL TEMPORARY TABLE RS2PICK (N INT) WITH REPLACE;
       CALL ${LIB}.SQLDEMORS2();
       ASSOCIATE RESULT SET LOCATORS (L1, L2) WITH PROCEDURE ${LIB}.SQLDEMORS2;
       ALLOCATE CUR2 CURSOR FOR RESULT SET L2;
       FETCH CUR2 INTO V;
       WHILE DONE = 0 DO
         INSERT INTO SESSION.RS2PICK VALUES (V);
         FETCH CUR2 INTO V;
       END WHILE;
       CLOSE CUR2;
       OPEN OUT1;
     END`
  ],
  [
    "関数",
    `CREATE FUNCTION ${LIB}.SQLDEMOF (P_ID INT) RETURNS DECIMAL(9,2)
     LANGUAGE SQL READS SQL DATA
     BEGIN
       DECLARE V DECIMAL(9,2);
       SET V = (SELECT QTY FROM ${LIB}.SQLDEMO WHERE ID = P_ID);
       RETURN CASE WHEN V IS NULL THEN 0 ELSE V * 2 END;
     END`
  ]
];

const { host, user, password } = target();
const conn = await DbConnection.connect({ host, user, password });
let failed = 0;
try {
  out(`${host} / ${user} / ${LIB}`);
  for (const sql of DROPS) {
    // 無ければ落ちる。**それでよい**（作り直しが目的なので、消せたかは問わない）
    try {
      await executeStatement(conn, sql);
    } catch (e) {
      /**
       * **握り潰してよいのは「無い」だけ。**
       *
       * 誰かが表を掴んでいると `DROP` は応答せず、20 秒で時間切れになる。
       * その時点で接続は使えなくなるので、黙って進むと**以降すべてが
       * 「接続が中断されました」で失敗し、本当の原因が見えない**（実際に踏んだ——
       * アプリを起動したままだと、プールの接続がロックを持っている）。
       */
      const msg = e instanceof Error ? e.message : String(e);
      if (/timed out|abandoned/u.test(msg)) {
        err(`${sql} が応答しません: ${msg}`);
        err("同じ表を掴んでいるものがあります。アプリ（start.sh / electron）を止めてから実行してください。");
        process.exit(2);
      }
    }
  }
  for (const [what, sql] of DDL) {
    try {
      const r = await executeStatement(conn, sql);
      const n = r.hasRowCount ? `${r.updateCount} 行` : "完了";
      // 実ライブラリーへの CREATE は警告つき成功で返る（SQLCODE 7905）。**捨てない**
      const w = r.warning ? `（SQLCODE=${r.warning.sqlCode}）` : "";
      out(`OK  ${what}: ${n}${w}`);
    } catch (e) {
      failed++;
      out(`NG  ${what}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  // 作ったものを一覧して見せる（残っていることを目で確かめられるように）
  const tables = await queryLimited(
    conn,
    `SELECT TABLE_NAME, TABLE_TYPE FROM QSYS2.SYSTABLES
      WHERE TABLE_SCHEMA = '${LIB}' AND TABLE_NAME LIKE 'SQLDEMO%' ORDER BY TABLE_NAME`,
    { limit: 50 }
  );
  const routines = await queryLimited(
    conn,
    `SELECT ROUTINE_NAME, ROUTINE_TYPE FROM QSYS2.SYSROUTINES
      WHERE ROUTINE_SCHEMA = '${LIB}' AND ROUTINE_NAME LIKE 'SQLDEMO%' ORDER BY ROUTINE_NAME`,
    { limit: 50 }
  );
  out("");
  out("残したもの:");
  for (const r of tables.rows) out(`  ${Object.values(r).join("  ")}`);
  for (const r of routines.rows) out(`  ${Object.values(r).join("  ")}`);
  out("");
  out("SQL 画面で試すとき:");
  out(`  SELECT * FROM ${LIB}.SQLDEMO ORDER BY ID`);
  out(`  CALL ${LIB}.SQLDEMOP(1, 1.50, ?)      -- 出力パラメーター`);
  out(`  CALL ${LIB}.SQLDEMORS()               -- 結果セット 1 個`);
  out(`  CALL ${LIB}.SQLDEMORS2()              -- 結果セット 2 個（1 個目だけ出る）`);
  out(`  CALL ${LIB}.SQLDEMOPICK()             -- その 2 個目（ロケーター経由の雛形）`);
  out(`  SELECT ID, ${LIB}.SQLDEMOF(ID) FROM ${LIB}.SQLDEMO ORDER BY ID`);
} finally {
  conn.close();
}
process.exit(failed === 0 ? 0 : 1);
