/**
 * **プログラム呼び出しの検証用 CL プログラム**を実機に作る（冪等）。
 *
 *   node --env-file=.env scripts/build-pgmtst.mjs
 *
 * `TESTLIB/PGMTST` は**参照渡しの引数を書き換える**だけの小さなプログラム:
 *
 * ```
 * PGM PARM(&NUM &TXT)
 *   &NUM = &NUM * 2        （詰め 10 進 15,5）
 *   &TXT = 'ECHO:' + &TXT  （文字 20）
 * ```
 *
 * ## なぜ CL なのか
 *
 * **CL の `PARM` は参照渡し**なので、1 つの引数で inout をそのまま試せる。
 * RPG だと DDS もコンパイルも要るが、CL は `CRTCLPGM` だけで済む。
 * `TYPE(*DEC) LEN(15 5)` は**詰め 10 進 8 バイト**で、`QCMDEXC` の長さ引数と同じ形。
 *
 * ソースは**SQL の INSERT で流し込む**（`build-attrtest.mjs` と同じ手口。
 * IFS も FTP も要らない）。
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { executeStatement } from "@ts5250/hostserver";
import { ConfigResolver, ServerConfigStore, PersonalConfigStore, openCommand, openDb } from "@ts5250/server";

const LIB = process.env.AS400_LIB ?? "TESTLIB";
const SRCF = "QCLSRC";
const MBR = "PGMTST";
const TMP = "/tmp/ts5250-pgmtst";
mkdirSync(TMP, { recursive: true });
const log = (s) => process.stdout.write(s + "\n");

const cfg = JSON.parse(readFileSync("connections.json", "utf8"));
const sys = cfg.systems.find((s) => s.name === "実機");
sys.signon = { user: sys.signon.user, passwordEnv: "AS400_PASSWORD" };
cfg.sessions = [];
writeFileSync(`${TMP}/cfg.json`, JSON.stringify(cfg));
const resolver = new ConfigResolver(
  ServerConfigStore.fromFile(`${TMP}/cfg.json`),
  new PersonalConfigStore({ systems: [], sessions: [] })
);
const connect = resolver.resolve({ system: `srv:${sys.id}` }, undefined, () => undefined).connect;

/** ソース 1 行ぶん（CL は桁位置に厳しくないが、先頭に空白を置く慣習に合わせる） */
const SOURCE = [
  "PGM PARM(&NUM &TXT)",
  "DCL VAR(&NUM) TYPE(*DEC) LEN(15 5)",
  "DCL VAR(&TXT) TYPE(*CHAR) LEN(20)",
  "CHGVAR VAR(&NUM) VALUE(&NUM * 2)",
  "CHGVAR VAR(&TXT) VALUE('ECHO:' *CAT &TXT)",
  "ENDPGM"
];

/**
 * **ゾーン 10 進の検証用**（`TESTLIB/PGMTSTZ`）。
 *
 * CL の `TYPE(*DEC)` は**詰め 10 進**なので、ゾーンは CL では表せない。RPG が要る。
 */
const RPG_SOURCE = [
  "**FREE",
  "dcl-pi *n;",
  "  num zoned(7:2);",
  "  txt char(20);",
  "end-pi;",
  "num = num * 2;",
  "txt = 'Z:' + %trimr(txt);",
  "return;"
];

const cmd = await openCommand(connect);
const db = await openDb(connect);
try {
  // **冪等**——作り直せるように、あるものは消してから作る
  for (const c of [
    `DLTPGM PGM(${LIB}/${MBR})`,
    `RMVM FILE(${LIB}/${SRCF}) MBR(${MBR})`
  ]) {
    const r = await cmd.run(c);
    log(`${c.padEnd(44)} → ${r.success ? "消した" : (r.messages[0]?.id ?? "無かった")}`);
  }

  const add = await cmd.run(`ADDPFM FILE(${LIB}/${SRCF}) MBR(${MBR}) SRCTYPE(CLP)`);
  log(`ADDPFM ${MBR}`.padEnd(44) + ` → ${add.success ? "OK" : add.messages[0]?.id}`);
  if (!add.success) throw new Error("メンバーを作れませんでした");

  // ソースを SQL で流し込む。**1 行 = 1 リテラル**（連結 `||` は変体文字の問題で使わない）。
  // **別名でメンバーを指す**——SQL からソース物理ファイルの特定メンバーへ書くには別名が要る
  const alias = `${MBR}A`;
  await executeStatement(db, `DROP ALIAS ${LIB}.${alias}`).catch(() => undefined);
  await executeStatement(db, `CREATE ALIAS ${LIB}.${alias} FOR ${LIB}.${SRCF} (${MBR})`);
  for (const [i, line] of SOURCE.entries()) {
    const seq = (i + 1) * 100;
    await executeStatement(
      db,
      `INSERT INTO ${LIB}.${alias} (SRCSEQ, SRCDAT, SRCDTA) VALUES (${seq}, 0, '${line.replace(/'/gu, "''")}')`
    );
  }
  await executeStatement(db, `DROP ALIAS ${LIB}.${alias}`).catch(() => undefined);
  log(`ソース ${SOURCE.length} 行を投入`);

  const crt = await cmd.run(`CRTCLPGM PGM(${LIB}/${MBR}) SRCFILE(${LIB}/${SRCF}) SRCMBR(${MBR})`);
  log(`CRTCLPGM ${MBR}`.padEnd(44) + ` → ${crt.success ? "OK" : crt.messages.map((m) => `${m.id} ${m.text}`).join(" / ")}`);
  if (!crt.success) throw new Error("コンパイルに失敗しました");
  log(`\n${LIB}/${MBR} を作りました`);

  // ---- ゾーン 10 進用（RPG）----
  const ZMBR = "PGMTSTZ";
  for (const c of [`DLTPGM PGM(${LIB}/${ZMBR})`, `RMVM FILE(${LIB}/QRPGLESRC) MBR(${ZMBR})`]) {
    const r = await cmd.run(c);
    log(`${c.padEnd(44)} → ${r.success ? "消した" : (r.messages[0]?.id ?? "無かった")}`);
  }
  const addZ = await cmd.run(`ADDPFM FILE(${LIB}/QRPGLESRC) MBR(${ZMBR}) SRCTYPE(RPGLE)`);
  log(`ADDPFM ${ZMBR}`.padEnd(44) + ` → ${addZ.success ? "OK" : addZ.messages[0]?.id}`);
  if (!addZ.success) throw new Error("RPG メンバーを作れませんでした");

  const zAlias = `${ZMBR}A`;
  await executeStatement(db, `DROP ALIAS ${LIB}.${zAlias}`).catch(() => undefined);
  await executeStatement(db, `CREATE ALIAS ${LIB}.${zAlias} FOR ${LIB}.QRPGLESRC (${ZMBR})`);
  for (const [i, line] of RPG_SOURCE.entries()) {
    await executeStatement(
      db,
      `INSERT INTO ${LIB}.${zAlias} (SRCSEQ, SRCDAT, SRCDTA) VALUES (${(i + 1) * 100}, 0, '${line.replace(/'/gu, "''")}')`
    );
  }
  await executeStatement(db, `DROP ALIAS ${LIB}.${zAlias}`).catch(() => undefined);
  log(`RPG ソース ${RPG_SOURCE.length} 行を投入`);

  const crtZ = await cmd.run(
    `CRTBNDRPG PGM(${LIB}/${ZMBR}) SRCFILE(${LIB}/QRPGLESRC) SRCMBR(${ZMBR}) DFTACTGRP(*NO)`
  );
  log(`CRTBNDRPG ${ZMBR}`.padEnd(44) + ` → ${crtZ.success ? "OK" : crtZ.messages.map((m) => `${m.id} ${m.text}`).join(" / ")}`);
  if (!crtZ.success) throw new Error("RPG のコンパイルに失敗しました");
  log(`${LIB}/${ZMBR} を作りました`);

  // ---- サービスプログラム（手続きを公開する）----
  // **`QSYS/QZRUCLSP` 経由で呼ぶ**ので、ここは普通のサービスプログラムでよい
  const SMBR = "SRVTST";
  const SRV_SOURCE = [
    "**FREE",
    "ctl-opt nomain;",
    "dcl-proc SRVADD export;",
    "  dcl-pi *n int(10);",
    "    a int(10) value;",
    "    b int(10) value;",
    "  end-pi;",
    "  return a + b;",
    "end-proc;",
    "dcl-proc SRVECHO export;",
    "  dcl-pi *n;",
    "    txt char(20);",
    "  end-pi;",
    "  txt = 'S:' + %trimr(txt);",
    "end-proc;",
    // **8 バイトの値渡しと 8 バイトの戻り**（4 バイトを超える型の確認用）
    "dcl-proc SRVADD8 export;",
    "  dcl-pi *n int(20);",
    "    a int(20) value;",
    "    b int(20) value;",
    "  end-pi;",
    "  return a + b;",
    "end-proc;",
    // **4 バイトを超える型は参照渡しで受ける**（QZRUCLSP の値渡しは 4 バイトまで）
    "dcl-proc SRVADD8R export;",
    "  dcl-pi *n;",
    "    a int(20) const;",
    "    b int(20) const;",
    "    r int(20);",
    "  end-pi;",
    "  r = a + b;",
    "end-proc;",
    "dcl-proc SRVDBLR export;",
    "  dcl-pi *n;",
    "    a float(8) const;",
    "    r float(8);",
    "  end-pi;",
    "  r = a * 2;",
    "end-proc;",
    // **ポインタの戻り**（QZRUCLSP が扱えるかの確認用）
    "dcl-proc SRVPTR export;",
    "  dcl-pi *n pointer;",
    "  end-pi;",
    "  dcl-s buf char(8) static;",
    "  buf = 'PTR-OK';",
    "  return %addr(buf);",
    "end-proc;",
    // **浮動小数の戻り**（QZRUCLSP が扱えるかの確認用）
    "dcl-proc SRVDBL export;",
    "  dcl-pi *n float(8);",
    "    a float(8) value;",
    "  end-pi;",
    "  return a * 2;",
    "end-proc;"
  ];
  for (const c of [`DLTSRVPGM SRVPGM(${LIB}/${SMBR})`, `RMVM FILE(${LIB}/QRPGLESRC) MBR(${SMBR})`]) {
    const r = await cmd.run(c);
    log(`${c.padEnd(44)} → ${r.success ? "消した" : (r.messages[0]?.id ?? "無かった")}`);
  }
  const addS = await cmd.run(`ADDPFM FILE(${LIB}/QRPGLESRC) MBR(${SMBR}) SRCTYPE(RPGLE)`);
  if (!addS.success) throw new Error("サービスプログラムのメンバーを作れませんでした");
  const sAlias = `${SMBR}A`;
  await executeStatement(db, `DROP ALIAS ${LIB}.${sAlias}`).catch(() => undefined);
  await executeStatement(db, `CREATE ALIAS ${LIB}.${sAlias} FOR ${LIB}.QRPGLESRC (${SMBR})`);
  for (const [i, line] of SRV_SOURCE.entries()) {
    await executeStatement(
      db,
      `INSERT INTO ${LIB}.${sAlias} (SRCSEQ, SRCDAT, SRCDTA) VALUES (${(i + 1) * 100}, 0, '${line.replace(/'/gu, "''")}')`
    );
  }
  await executeStatement(db, `DROP ALIAS ${LIB}.${sAlias}`).catch(() => undefined);

  // **`EXPORT(*ALL)` で手続き名をそのまま公開する**（バインダー言語を書かずに済む）
  const crtS = await cmd.run(
    `CRTRPGMOD MODULE(${LIB}/${SMBR}) SRCFILE(${LIB}/QRPGLESRC) SRCMBR(${SMBR})`
  );
  log(`CRTRPGMOD ${SMBR}`.padEnd(44) + ` → ${crtS.success ? "OK" : crtS.messages.map((m) => `${m.id} ${m.text}`).join(" / ")}`);
  if (!crtS.success) throw new Error("モジュールのコンパイルに失敗しました");
  const bnd = await cmd.run(
    `CRTSRVPGM SRVPGM(${LIB}/${SMBR}) MODULE(${LIB}/${SMBR}) EXPORT(*ALL)`
  );
  log(`CRTSRVPGM ${SMBR}`.padEnd(44) + ` → ${bnd.success ? "OK" : bnd.messages.map((m) => `${m.id} ${m.text}`).join(" / ")}`);
  if (!bnd.success) throw new Error("サービスプログラムの作成に失敗しました");
  log(`${LIB}/${SMBR} を作りました（SRVADD / SRVECHO）`);
} finally {
  cmd.close();
  db.close();
}
