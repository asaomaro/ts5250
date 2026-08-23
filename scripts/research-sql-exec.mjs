// 実機で**結果を返さない SQL 文**（DML / DDL）を実行できるかを実測する。
//
// 問い（`.aidev/backlog/hostserver.md`「SQL の複数文実行からの積み残し」）:
//   前回の調査は `executeImmediate`(0x1806) と `prepare`(0x1800) を試して
//   どちらも `rcClass=2 / -215` に拒否され、「拡張形式の文テキストか RPB の設定が鍵」と
//   見立てを残した（`20260723-sql-multi-statement` research F2）。
//
//   **しかし同じリポジトリの `insert.ts` は INSERT を実機で実行できている**——
//   `prepareAndDescribe`(0x1803) → `changeDescriptor` → `execute`(0x1805) の 3 段。
//   つまり `executeImmediate` を通す必要は無いかもしれない。
//
// ここで確かめること（**マーカーが 1 つも無い文**で）:
//   1. `prepareAndDescribe` が通るか。マーカー形式は返るか（返らないなら要らない）
//   2. `execute` に**マーカーデータを載せない**形が受け付けられるか
//   3. DML（DELETE/UPDATE）と DDL（CREATE/DROP）の両方が通るか
//   4. 影響行数は SQLCA の `updateCount` に入るか
//   5. 文型（`sqlStatementType`）は 1 でよいか
//
// 実行: AS400_PASSWORD=... node scripts/research-sql-exec.mjs
import { readFileSync } from "node:fs";
import { DbConnection, query } from "@ts5250/tn5250";
import { DB_CP, DB_REQ, ORS } from "../packages/tn5250/dist/hostserver/db/db-datastream.js";
import { parseSqlca } from "../packages/tn5250/dist/hostserver/db/db-reply.js";
import { findParam } from "../packages/tn5250/dist/hostserver/datastream.js";
import { codecForCcsid } from "@ts5250/ebcdic";

const out = (s) => process.stdout.write(s + "\n");
// **QTEMP を使う**（必ず存在し、接続ごとに消えるので後片付けが要らない）
const LIB = "QTEMP";
const T = "SQLEXEC";
const SQL_TEXT_CCSID = 13488;
const IDENTIFIER_CCSID = 37;
const NAME = "ASEXEC";

const conns = JSON.parse(readFileSync("connections.json", "utf8"));
const sys = conns.systems.find((s) => s.name === (process.env.AS400_SYSTEM ?? "AS400"));
const password = process.env.AS400_PASSWORD;
if (!password) { out("AS400_PASSWORD が未設定です"); process.exit(1); }

// **`insert.ts` と同じ組み立て**（先頭 4 バイトが CCSID＋長さ。13488 は UTF-16BE で
// ebcdic の表には無いので、桁を自分で並べる）
const sqlText = (cp, str) => {
  const out = new Uint8Array(4 + str.length * 2);
  const v = new DataView(out.buffer);
  v.setUint16(0, SQL_TEXT_CCSID);
  v.setUint16(2, str.length * 2);
  for (let i = 0; i < str.length; i++) v.setUint16(4 + i * 2, str.charCodeAt(i));
  return { cp, value: out };
};
const identifier = (cp, str) => {
  const { bytes } = codecForCcsid(IDENTIFIER_CCSID).encode(str);
  const out = new Uint8Array(4 + bytes.length);
  const v = new DataView(out.buffer);
  v.setUint16(0, IDENTIFIER_CCSID);
  v.setUint16(2, bytes.length);
  out.set(bytes, 4);
  return { cp, value: out };
};
const num = (cp, value, bytes) => {
  const b = new Uint8Array(bytes);
  new DataView(b.buffer).setUint16(0, value);
  return { cp, value: b };
};

const DIAG = ORS.sendReplyImmediately | ORS.sqlca | ORS.messageId | ORS.firstLevelText;

function describe(reply) {
  const raw = findParam(reply, DB_CP.sqlca);
  const ca = raw ? parseSqlca(raw) : undefined;
  const marker = findParam(reply, DB_CP.parameterMarkerFormat);
  return {
    // **成否は SQLCODE で見る。** `rcClass` は `Reply` に無い欄で、参照すると
    // 常に undefined ＝ 常に失敗扱いになる（この検証で実際に踏んだ）
    templateErr: reply.dbTemplate?.rcClass,
    sqlCode: ca?.sqlCode,
    sqlState: ca?.sqlState,
    updateCount: ca?.updateCount,
    markerBytes: marker?.length
  };
}

/** `prepareAndDescribe` → `execute`（**マーカーデータ無し**） */
async function run(conn, sql, statementType) {
  const prep = await conn.request({
    reqId: DB_REQ.prepareAndDescribe,
    orsBitmap: DIAG | ORS.parameterMarkerFormat | ORS.extendedColumnDescriptors,
    params: [
      identifier(DB_CP.prepareStatementName, NAME),
      sqlText(DB_CP.sqlStatementText, sql),
      num(DB_CP.sqlStatementType, statementType, 2)
    ],
    allowTemplateError: true
  });
  const p = describe(prep);
  // SQLCODE が負なら準備に失敗（正の値は警告）
  if ((p.sqlCode ?? -1) < 0) return { stage: "prepare", ...p };

  const exec = await conn.request({
    reqId: DB_REQ.execute,
    orsBitmap: DIAG,
    params: [
      identifier(DB_CP.prepareStatementName, NAME),
      num(DB_CP.sqlStatementType, statementType, 2)
    ],
    allowTemplateError: true
  });
  return { stage: "execute", prepare: p, ...describe(exec) };
}

let conn;
try {
  conn = await DbConnection.connect({
    host: sys.host, user: sys.signon.user, password,
    ...(sys.tls !== undefined ? { tls: sys.tls } : {})
  });
  out(`接続 OK（${sys.host}）\n`);

  const CASES = [
    { lab: "DROP（前回の残りを消す・失敗してよい）", sql: `DROP TABLE ${LIB}.${T}`, type: 1 },
    { lab: "**CREATE TABLE（DDL）**", sql: `CREATE TABLE ${LIB}.${T} (ID INT, S CHAR(10))`, type: 1 },
    { lab: "**INSERT（マーカー無し）**", sql: `INSERT INTO ${LIB}.${T} VALUES(1, 'a')`, type: 1 },
    { lab: "INSERT もう 2 行", sql: `INSERT INTO ${LIB}.${T} VALUES(2, 'b')`, type: 1 },
    { lab: "**UPDATE（影響 2 行）**", sql: `UPDATE ${LIB}.${T} SET S = 'z'`, type: 1 },
    { lab: "**DELETE（影響 1 行）**", sql: `DELETE FROM ${LIB}.${T} WHERE ID = 1`, type: 1 },
    { lab: "文型 0 でも通るか（UPDATE）", sql: `UPDATE ${LIB}.${T} SET S = 'y'`, type: 0 },
    { lab: "構文誤り（失敗の形を見る）", sql: `UPDATE ${LIB}.${T} SET`, type: 1 },
    { lab: "存在しない表（失敗の形を見る）", sql: `DELETE FROM ${LIB}.NOSUCHTBL`, type: 1 },
    { lab: "**SELECT を非クエリ経路に流したら**", sql: `SELECT * FROM ${LIB}.${T}`, type: 1 },
    // **利用者のライブラリーに書けるか**（QTEMP は通ったが、実ライブラリーはどうか）。
    // SQL 命名（`.`）とシステム命名（`/`）で結果が変わるかを見る
    { lab: "実ライブラリー・SQL 命名（TESTLIB.T2）", sql: `CREATE TABLE TESTLIB.SQLEXEC2 (ID INT)`, type: 1 },
    { lab: "実ライブラリー・システム命名（TESTLIB/T2）", sql: `CREATE TABLE TESTLIB/SQLEXEC2 (ID INT)`, type: 1 },
    { lab: "後片付け（TESTLIB）", sql: `DROP TABLE TESTLIB.SQLEXEC2`, type: 1 }
  ];

  for (const c of CASES) {
    let r;
    try {
      r = await run(conn, c.sql, c.type);
    } catch (e) {
      r = { thrown: e instanceof Error ? e.message : String(e) };
    }
    out(`---- ${c.lab}`);
    out(`     ${c.sql}`);
    out(`     ${JSON.stringify(r)}`);
  }

  // 最後に SELECT で中身を確かめる（DML が本当に効いたか）
  out("\n---- 実際の中身（SELECT で確認）");
  const res = await query(conn, `SELECT ID, S FROM ${LIB}.${T} ORDER BY ID`);
  for (const row of res.rows) out("     " + JSON.stringify(row));
  await run(conn, `DROP TABLE ${LIB}.${T}`, 1);
} catch (e) {
  out("ERROR: " + (e instanceof Error ? e.message : String(e)));
  out(e?.stack ?? "");
} finally {
  conn?.close?.();
}
