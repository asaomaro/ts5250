// **RPG コンパイラが PCML を吐くか**を実機で測る。
//
// jt400 の `ProgramCallDocument` は**ホストへ問い合わせない**（構築子を全て読んだ）。
// PCML の出どころはコンパイラ——`CRTBNDRPG ... PGMINFO(*PCML) INFOSTMF('/…')`。
// つまり取りに行く先は API ではなく **IFS**。それが本当に通るのかを確かめる。
//
// 併せて、**構造体と配列がどう書き出されるか**を見る（うちに一番足りていない所）。
//
// 実行: node --env-file=.env scripts/research-pcml.mjs
//
// 副作用: TESTLIB に PCMLTST を作り、IFS に .pcml を残す（後から消せる）。
import { CommandConnection, DbConnection, IfsConnection, executeStatement } from "@ts5250/hostserver";

const host = process.env.AS400_HOST;
const user = process.env.AS400_USER;
const password = process.env.AS400_PASSWORD;
if (!host || !user || !password) {
  process.stderr.write("AS400_HOST / AS400_USER / AS400_PASSWORD を環境変数で渡してください\n");
  process.exit(2);
}

const LIB = process.env.AS400_LIB ?? "TESTLIB";
const DIR = process.env.AS400_IFS_DIR ?? `/home/${user}`;
const MBR = "PCMLTST";
const STMF = `${DIR}/${MBR.toLowerCase()}.pcml`;
const log = (s) => process.stdout.write(s + "\n");

/**
 * 構造体・配列・各種の型を 1 本に詰めた試験片。
 * **PCML が何を書き出すか**を見るのが目的なので、処理は最小限。
 */
const RPG = [
  "**FREE",
  "dcl-ds custT qualified template;",
  "  id packed(7:0);",
  "  nm char(20);",
  "  rate packed(9:4);",
  "end-ds;",
  "dcl-pi *n;",
  "  inTxt char(10) const;",
  "  ioNum packed(9:2);",
  "  rec likeds(custT);",
  "  items char(5) dim(4);",
  "  cnt int(10);",
  "  big int(20);",
  "  amt zoned(7:2);",
  "end-pi;",
  "ioNum = ioNum * 2;",
  "rec.id = 7;",
  "rec.nm = 'REC:' + %trimr(inTxt);",
  "rec.rate = 1.5;",
  "items(1) = 'AAA';",
  "items(2) = 'BBB';",
  "items(3) = 'CCC';",
  "items(4) = 'DDD';",
  "cnt = 4;",
  "big = 9000000000;",
  "amt = amt + 1;",
  "return;"
];

const cmd = await CommandConnection.connect({ host, user, password });
const db = await DbConnection.connect({ host, user, password });
const ifs = await IfsConnection.connect({ host, user, password });
const run = async (c) => {
  const r = await cmd.run(c);
  log(`  ${c.slice(0, 70).padEnd(72)} → ${r.success ? "OK" : r.messages.map((m) => `${m.id} ${m.text}`).join(" / ")}`);
  return r;
};

try {
  log("### 1. 試験片を作る");
  await run(`DLTPGM PGM(${LIB}/${MBR})`);
  await run(`RMVM FILE(${LIB}/QRPGLESRC) MBR(${MBR})`);
  const add = await run(`ADDPFM FILE(${LIB}/QRPGLESRC) MBR(${MBR}) SRCTYPE(RPGLE)`);
  if (!add.success) throw new Error("メンバーを作れませんでした");

  const alias = `${MBR}A`;
  await executeStatement(db, `DROP ALIAS ${LIB}.${alias}`).catch(() => undefined);
  await executeStatement(db, `CREATE ALIAS ${LIB}.${alias} FOR ${LIB}.QRPGLESRC (${MBR})`);
  for (const [i, line] of RPG.entries()) {
    await executeStatement(
      db,
      `INSERT INTO ${LIB}.${alias} (SRCSEQ, SRCDAT, SRCDTA) VALUES (${(i + 1) * 100}, 0, '${line.replace(/'/gu, "''")}')`
    );
  }
  await executeStatement(db, `DROP ALIAS ${LIB}.${alias}`).catch(() => undefined);
  log(`  ソース ${RPG.length} 行を投入`);

  log("\n### 2. PGMINFO(*PCML) でコンパイルできるか");
  await run(`RMVLNK OBJLNK('${STMF}')`);
  const crt = await run(
    `CRTBNDRPG PGM(${LIB}/${MBR}) SRCFILE(${LIB}/QRPGLESRC) SRCMBR(${MBR}) DFTACTGRP(*NO)` +
      ` PGMINFO(*PCML) INFOSTMF('${STMF}')`
  );
  if (!crt.success) {
    log("  → PGMINFO(*PCML) が通らない。素のコンパイルを試す");
    await run(`CRTBNDRPG PGM(${LIB}/${MBR}) SRCFILE(${LIB}/QRPGLESRC) SRCMBR(${MBR}) DFTACTGRP(*NO)`);
    throw new Error("PGMINFO(*PCML) は使えない");
  }

  log("\n### 3. 吐かれた PCML を読む");
  const got = await ifs.readTextFile(STMF);
  log(`  ${STMF} → タグ=${got.ccsid ?? "なし"} / ${got.data.length} バイト`);
  log("--- ここから中身 ---");
  log(new TextDecoder().decode(got.data));
  log("--- ここまで ---");
} finally {
  cmd.close();
  db.close?.();
  ifs.close?.();
}
