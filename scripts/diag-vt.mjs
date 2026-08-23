// **IBM i が VT の画面を出さないときに、原因をホスト側から突き止める。**
//
// 実機は交渉まで進むのに画面が 1 バイトも来ない。**読むだけ**——構成は何も変えない。
//
// 実行: node --env-file=.env --env-file=.env.verify scripts/diag-vt.mjs
//       PROBE=PUB400 で比較対象（動く方）を見る
//
// ## 分かっていること（2026-08-22 実測）
//
// 1. `QTVDEVICE`（TELNET の装置管理）が仮想装置を **`TYPE(V100) MODEL(*ASCII)
//    KBDTYPE(USB)`** で作ってオンにする
// 2. サブシステム（QBASE）が割り振り、サインオン画面 `QSYS/QDSIGNON` を開こうとする
// 3. **`CPF5553 漢字文字セット装置が必要となることがある`** → `CPF5511` → `CPF1398`
//    → `CPF1194`（装置をオフに構成変更）→ 1 に戻る、を繰り返す
//
// **日本語の IBM i ではサインオン画面の DDS が日本語の定数で書かれている**
// （`QGPL/QDDSSRC(QDSIGNON)` に `'サイン・オン'` 等）。DBCS 定数を含む表示ファイルは
// 漢字装置を要求するが、**VT の装置は必ず ASCII** で作られる。
//
// ⚠ **クライアント側では直せない。** RFC 2877 の `KBDTYPE`/`CODEPAGE` を JKB/290 で
// 申告しても装置は `KBDTYPE(USB) MODEL(*ASCII)` のまま（実測）。装置名（`DEVNAME`）も
// 使われない。**ホストの構成の話**。
import { VtSession } from "@ts5250/vt";
import { DbConnection, query, executeStatement } from "@ts5250/hostserver";

const PRE = process.env.PROBE === "PUB400" ? "PUB400" : "AS400";
const host = process.env[`${PRE}_HOST`];
const user = process.env[`${PRE}_USER`];
const password = process.env[`${PRE}_PASSWORD`];
if (!host || !user || !password) { process.stderr.write(`${PRE}_* が要ります\n`); process.exit(2); }

const out = (s) => process.stdout.write(s + "\n");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rows = (r) => r.rows.map((x) => Object.values(x).map((v) => String(v ?? "").trim()));

out(`# ${PRE} — VT で繋いで再現させる`);
const s = new VtSession({ host, port: 23, rows: 24, cols: 80, terminalTypes: ["VT220"], ccsid: PRE === "PUB400" ? 37 : 930 });
let closed = "";
s.on("close", (r) => { closed = r; });
await s.open();
await sleep(6000);
const screen = s.snapshot().cells.map((r) => r.map((c) => c.char).join("").trimEnd()).join("\n").trim();
out(`  交渉: IBM i=${s.isIbmI} / 端末タイプ=${s.terminalType} / ECHO=${s.hostEchoes}`);
out(`  画面: ${screen === "" ? "**1 バイトも来ていない**" : screen.split("\n").find((l) => l.trim())}`);
out(`  切断: ${closed || "(繋がったまま)"}`);
s.close();
await sleep(1500);

const db = await DbConnection.connect({ host, user, password });
// **QTEMP は同じ接続のもの**なので、SQL 経由で CL を走らせれば結果をそのまま読める（後に残らない）
const cl = (c) => executeStatement(db, `CALL QSYS2.QCMDEXC('${c.replace(/'/g, "''")}')`);

out(`\n# サブシステムのジョブログ（**CPF5511 の実際の中身**がここにある）`);
const sbs = await query(db, `SELECT SUBSYSTEM_MONITOR_JOB FROM QSYS2.SUBSYSTEM_INFO
  WHERE STATUS='ACTIVE' AND SUBSYSTEM_DESCRIPTION IN ('QBASE','QINTER')`);
for (const [job] of rows(sbs)) {
  try {
    const j = await query(db, `SELECT MESSAGE_ID, MESSAGE_TEXT FROM TABLE(QSYS2.JOBLOG_INFO('${job}'))
      WHERE MESSAGE_ID IN ('CPF5511','CPF5553','CPF1194','CPF1398','CPF1195')
      ORDER BY MESSAGE_TIMESTAMP DESC FETCH FIRST 6 ROWS ONLY`);
    out(`  ${job}`);
    for (const r of rows(j)) out(`    ${r[0]}  ${r[1]}`);
  } catch (e) { out(`  ${job}: 読めず ${e.message.slice(0, 80)}`); }
}

out(`\n# サブシステムが使うサインオン画面`);
const sg = await query(db, `SELECT SUBSYSTEM_DESCRIPTION, SIGNON_DEVICE_FILE_LIBRARY, SIGNON_DEVICE_FILE
  FROM QSYS2.SUBSYSTEM_INFO WHERE STATUS='ACTIVE'`);
for (const r of rows(sg)) out(`  ${r.join("  |  ")}`);

out(`\n# 作られた仮想装置の種類（**VT は V100 / *ASCII**）`);
await cl("CRTSRCPF FILE(QTEMP/QCLSRC) RCDLEN(112)");
const devs = await query(db, `SELECT OBJNAME FROM TABLE(QSYS2.OBJECT_STATISTICS('QSYS','DEVD'))
  WHERE OBJNAME LIKE 'QPADEV%' ORDER BY OBJCREATED DESC FETCH FIRST 3 ROWS ONLY`);
for (const [dev] of rows(devs)) {
  try {
    await cl(`RTVCFGSRC CFGD(${dev}) CFGTYPE(*DEVD) SRCFILE(QTEMP/QCLSRC) SRCMBR(${dev})`);
    await executeStatement(db, `CREATE ALIAS QTEMP.A${dev.slice(-4)} FOR QTEMP.QCLSRC(${dev})`);
    const src = await query(db, `SELECT SRCDTA FROM QTEMP.A${dev.slice(-4)} ORDER BY SRCSEQ`);
    const line = rows(src).map((r) => r[0]).join(" ");
    const g = (k) => line.match(new RegExp(`${k}\\((\\S+?)\\)`))?.[1] ?? "?";
    out(`  ${dev}: TYPE=${g("TYPE")} MODEL=${g("MODEL")} KBDTYPE=${g("KBDTYPE")}`);
  } catch (e) { out(`  ${dev}: ${e.message.slice(0, 80)}`); }
}

out(`\n# 英語（非 DBCS）のサインオン画面がホストに在るか`);
const libs = await query(db, `SELECT SCHEMA_NAME FROM QSYS2.SYSSCHEMAS
  WHERE SCHEMA_NAME LIKE 'QSYS29%' ORDER BY SCHEMA_NAME`);
for (const [lib] of rows(libs)) {
  const f = await query(db, `SELECT OBJNAME FROM TABLE(QSYS2.OBJECT_STATISTICS('${lib}','FILE'))
    WHERE OBJNAME LIKE 'QDSIGNON%'`);
  const n = rows(f).map((r) => r[0]);
  if (n.length) out(`  ${lib}: ${n.join(", ")}`);
}
out(`  （2924 = 英語・大小文字。**非 DBCS**）`);
await db.close();
