// **VT（ASCII）端末だけを別のサブシステムに寄せて、英語のサインオン画面を使わせる。**
//
// 日本語の IBM i では、サインオン画面 `QSYS/QDSIGNON` の DDS が日本語の定数で書かれており、
// **漢字装置を要求する**。VT の仮想装置は必ず `TYPE(V100) MODEL(*ASCII) KBDTYPE(USB)` で
// 作られるので開けず、`CPF5553 → CPF5511 → CPF1194` で装置がオフに戻される
// （`scripts/diag-vt.mjs` / `scripts/README.md` の VT 節）。
//
// **`ADDWSE` の `WRKSTNTYPE` は `*ASCII` / `*NONASCII` を受ける**（実機のコマンド定義で確認）。
// VT だけが `*ASCII` なので、**5250 と 3270 に一切触らずに**切り分けられる:
//
//   - 3270 の装置は `TYPE(3279) KBDTYPE(JKB)`＝`*NONASCII`（実測）→ 影響なし
//   - 5250 の装置も `*NONASCII` → 影響なし
//
// 実行:
//   node --env-file=.env --env-file=.env.verify scripts/setup-vt-subsystem.mjs status    # 今の姿を見る
//   node --env-file=.env --env-file=.env.verify scripts/setup-vt-subsystem.mjs apply     # 作って始める
//   node --env-file=.env --env-file=.env.verify scripts/setup-vt-subsystem.mjs rollback  # 元に戻す
//
// ⚠ **制御サブシステム QBASE のワークステーション項目に手を入れる。**
// 足すのは `WRKSTNTYPE(*ASCII) AT(*ENTER)` の 1 行だけで、`*ALL`/`*CONS`/`5555` は触らない。
// 戻すのは `RMVWSE` 1 つ。
import { DbConnection, query, executeStatement } from "@ts5250/hostserver";

const SBSD_LIB = process.env.VT_SBSD_LIB ?? process.env.AS400_LIB ?? "TESTLIB";
const SBSD = process.env.VT_SBSD ?? "VTSBS";
/** 英語（非 DBCS）のサインオン画面。**IBM 出荷の 2 次言語ライブラリのもの** */
const SGNDSPF = process.env.VT_SGNDSPF ?? "QSYS2924/QDSIGNON";

const host = process.env.AS400_HOST;
const user = process.env.AS400_USER;
const password = process.env.AS400_PASSWORD;
if (!host || !user || !password) { process.stderr.write("AS400_* が要ります\n"); process.exit(2); }

const mode = process.argv[2] ?? "status";
const out = (s) => process.stdout.write(s + "\n");
const db = await DbConnection.connect({ host, user, password });
const rows = (r) => r.rows.map((x) => Object.values(x).map((v) => String(v ?? "").trim()));

/** CL を 1 つ走らせる。失敗はホストのメッセージをそのまま見せる */
async function cl(cmd, { allowFail = false } = {}) {
  try {
    await executeStatement(db, `CALL QSYS2.QCMDEXC('${cmd.replace(/'/g, "''")}')`);
    out(`  OK   ${cmd}`);
    return true;
  } catch (e) {
    out(`  ${allowFail ? "--  " : "NG  "} ${cmd}`);
    out(`       ${String(e.message).replace(/\s+/g, " ").slice(0, 220)}`);
    if (!allowFail) throw e;
    return false;
  }
}

async function status() {
  out("# サブシステム");
  const s = await query(db, `SELECT DISTINCT SUBSYSTEM_DESCRIPTION_LIBRARY, SUBSYSTEM_DESCRIPTION, STATUS,
      SIGNON_DEVICE_FILE_LIBRARY, SIGNON_DEVICE_FILE
    FROM QSYS2.SUBSYSTEM_INFO WHERE SUBSYSTEM_DESCRIPTION IN ('QBASE','${SBSD}')`);
  const r = rows(s);
  out(r.length ? r.map((x) => "  " + x.join("  |  ")).join("\n") : "  （見つからない）");

  out("\n# ワークステーション項目（種類）");
  const w = await query(db, `SELECT DISTINCT SUBSYSTEM_DESCRIPTION, WORKSTATION_TYPE, ALLOCATION
    FROM QSYS2.WORKSTATION_INFO WHERE SUBSYSTEM_DESCRIPTION IN ('QBASE','${SBSD}')
      AND WORKSTATION_TYPE IS NOT NULL ORDER BY SUBSYSTEM_DESCRIPTION, WORKSTATION_TYPE`);
  for (const x of rows(w)) out(`  ${x[0]}: 種類=${x[1]} 割振=${x[2]}`);
}

if (mode === "status") {
  await status();
} else if (mode === "apply") {
  out(`# VT 用サブシステムを作る（${SBSD_LIB}/${SBSD}、サインオン画面 ${SGNDSPF}）\n`);
  const [sgnLib, sgnFile] = SGNDSPF.split("/");
  await cl(`CRTSBSD SBSD(${SBSD_LIB}/${SBSD}) POOLS((1 *BASE) (2 *INTERACT)) SGNDSPF(${sgnLib}/${sgnFile}) TEXT('VT (ASCII) terminals - see scripts/README.md')`);
  // 対話ジョブの経路指定は QBASE と同じ形に揃える（QCMDI → QSYS/QCMD、クラスは QGPL/QINTER）
  await cl(`ADDRTGE SBSD(${SBSD_LIB}/${SBSD}) SEQNBR(50) CMPVAL(QCMDI) PGM(QSYS/QCMD) CLS(QGPL/QINTER) POOLID(2)`);
  await cl(`ADDRTGE SBSD(${SBSD_LIB}/${SBSD}) SEQNBR(9999) CMPVAL(*ANY) PGM(QSYS/QCMD) CLS(QGPL/QINTER) POOLID(2)`);
  // **ここが要**——ASCII の装置はこのサブシステムがサインオンを出す
  await cl(`ADDWSE SBSD(${SBSD_LIB}/${SBSD}) WRKSTNTYPE(*ASCII) AT(*SIGNON)`);
  // **QBASE には拾わせない**（*ALL より種類指定が優先される）。5250 / 3270 は *NONASCII なので無関係
  await cl(`ADDWSE SBSD(QSYS/QBASE) WRKSTNTYPE(*ASCII) AT(*ENTER)`);
  await cl(`STRSBS SBSD(${SBSD_LIB}/${SBSD})`);
  out("");
  await status();
} else if (mode === "rollback") {
  out("# 元に戻す\n");
  await cl(`ENDSBS SBS(${SBSD}) OPTION(*IMMED)`, { allowFail: true });
  // 終わるまで少し待つ
  await new Promise((r) => setTimeout(r, 5000));
  await cl(`RMVWSE SBSD(QSYS/QBASE) WRKSTNTYPE(*ASCII)`, { allowFail: true });
  await cl(`DLTSBSD SBSD(${SBSD_LIB}/${SBSD})`, { allowFail: true });
  out("");
  await status();
} else {
  out("使い方: status | apply | rollback");
}
await db.close();
