// **純 DBCS の DBCLOB**（CCSID 16684 / 300）を実機で確かめる。
//
// `20260801-dbclob-locator-decode`（PR #248）で長さの単位を CCSID で分けたが、
// 実機で測ったのは **UTF-16（1200）だけ**。`isTwoByteCcsid` は純 DBCS も
// 2 バイト/文字として扱うが、**その CCSID の DBCLOB 列を作って測ってはいない**。
//
// ロケーター経由とインライン（しきい値以下）の**両方**で確かめる。
//
// 実行: AS400_HOST=... AS400_USER=... AS400_PASSWORD=... node --env-file=.env --env-file=.env.verify \
//         scripts/research-pure-dbcs-lob.mjs
import { DbConnection, executeStatement, query } from "@ts5250/hostserver";

const host = process.env.AS400_HOST;
const user = process.env.AS400_USER;
const password = process.env.AS400_PASSWORD;
if (!host || !user || !password) {
  process.stderr.write("AS400_HOST / AS400_USER / AS400_PASSWORD を環境変数で渡してください\n");
  process.exit(2);
}

const LIB = process.env.AS400_LIB ?? "TESTLIB";
const TABLE = `${LIB}.PDBCLOB`;
/** 純 DBCS の CCSID。`AS400_DBCS_CCSID` で差し替えられる（16684 / 300 が対象） */
const DBCS_CCSID = Number(process.env.AS400_DBCS_CCSID ?? 300);
const log = (s) => process.stdout.write(s + "\n");
const hex = (b) => [...b].map((x) => x.toString(16).padStart(2, "0")).join(" ");
let pass = 0;
let fail = 0;
const check = (cond, msg) => {
  if (cond) { pass++; log(`  PASS ${msg}`); } else { fail++; log(`  FAIL ${msg}`); }
};

/** 全角のみ（純 DBCS には半角英数字が入らない） */
const ROWS = [
  { id: 1, text: "日本語" },
  { id: 2, text: "全角混在" }
];

/** 接続を開く。しきい値を渡すとインライン経路になる */
const open = (lobFieldThreshold) =>
  DbConnection.connect({ host, user, password, ...(lobFieldThreshold ? { lobFieldThreshold } : {}) });

// ---- 準備 ----
{
  const conn = await open(0);
  try {
    try { await executeStatement(conn, `DROP TABLE ${TABLE}`); } catch { /* 無ければ良い */ }
    // **純 DBCS**（`isPureDbcsCcsid` が持つ表は 16684 と 300）。UTF-16 とは別経路で復号される
    await executeStatement(conn, `CREATE TABLE ${TABLE} (ID INT NOT NULL, G DBCLOB(1K) CCSID ${DBCS_CCSID})`);
    for (const r of ROWS) {
      // **直接の変換が無い**（ジョブの 5035 → 300 は `-332/57017`）。
      // **1200 を経由すれば通る**——実機で確かめた
      await executeStatement(
        conn,
        `INSERT INTO ${TABLE} VALUES (${r.id}, CAST(CAST('${r.text}' AS DBCLOB(1K) CCSID 1200) AS DBCLOB(1K) CCSID ${DBCS_CCSID}))`
      );
    }
    log(`フィクスチャ: ${TABLE}（${ROWS.length} 行 / CCSID ${DBCS_CCSID}）\n`);
  } finally {
    conn.close();
  }
}

/** 1 つの設定で引いて中身を確かめる */
async function run(label, threshold, lobMaxBytes) {
  const conn = await open(threshold);
  const seen = [];
  if (!threshold) {
    const orig = conn.request.bind(conn);
    conn.request = async (o) => {
      const r = await orig(o);
      if (o.reqId === 0x1816) for (const p of r.params ?? []) if (p.cp === 0x380f) seen.push(p.value);
      return r;
    };
  }
  try {
    log(`### ${label}`);
    const res = await query(conn, `SELECT ID, G FROM ${TABLE} ORDER BY ID`, lobMaxBytes ? { lob: { maxBytes: lobMaxBytes } } : {});
    for (let i = 0; i < res.rows.length; i++) {
      const want = ROWS[i];
      const v = res.rows[i].G;
      const got = typeof v.value === "string" ? v.value : null;
      log(`  ID=${want.id} 期待 "${want.text}"（${want.text.length} 文字 / ${want.text.length * 2} バイト）`);
      log(`    返り値: ${got !== null ? `"${got}"` : `<bytes ${v.value?.length ?? 0}>`} byteLength=${v.byteLength}`);
      const raw = seen[i];
      if (raw) {
        const view = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
        log(`    生: ccsid=${view.getUint16(0)} 宣言長=${view.getUint32(2)} 本体=${raw.length - 6} バイト`);
        log(`      hex: ${hex(raw.subarray(6, 6 + 16))}`);
      }
      check(got === want.text, `"${want.text}" が文字列で返る`);
      check(v.byteLength === want.text.length * 2, `byteLength が ${want.text.length * 2}（実際: ${v.byteLength}）`);
    }
    log("");
  } finally {
    conn.close();
  }
}

// **ロケーター経由**（既定）と**インライン**（しきい値以下）の両方
await run("ロケーター経由（しきい値 0 ＋ 取得指定）", 0, 64 * 1024);
await run("インライン（しきい値 65536）", 64 * 1024);

log(`${fail === 0 ? "OK" : "NG"} — ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
