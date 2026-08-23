// ロケーター経由の DBCLOB 取得が壊れている件を実機で詰める。
//
// `20260801-lob-threshold-realhost` F5 で発見: しきい値 0（既定）で DBCLOB(CCSID 1200) の
// 中身を取ると、`日本語`（3 文字 / 6 バイト）が **3 バイト**、`全角混在ab`（6 文字 / 12 バイト）が
// **6 バイト**で返り、しかも文字列に復号されず Uint8Array のまま。
//
// **長さの単位（文字数 vs バイト数）と、UTF-16 の復号**——どちらが原因かを生バイトで確かめる。
//
// 実行: AS400_HOST=... AS400_USER=... AS400_PASSWORD=... node --env-file=.env --env-file=.env.verify \
//         scripts/research-dbclob-locator.mjs
import { DbConnection, executeStatement, query } from "@ts5250/hostserver";

const host = process.env.AS400_HOST;
const user = process.env.AS400_USER;
const password = process.env.AS400_PASSWORD;
if (!host || !user || !password) {
  process.stderr.write("AS400_HOST / AS400_USER / AS400_PASSWORD を環境変数で渡してください\n");
  process.exit(2);
}

const LIB = process.env.AS400_LIB ?? "TESTLIB";
const TABLE = `${LIB}.DBCLOBT`;
const log = (s) => process.stdout.write(s + "\n");
const hex = (b) => [...b].map((x) => x.toString(16).padStart(2, "0")).join(" ");

/** 期待値（UTF-16 の文字数とバイト数） */
const ROWS = [
  { id: 1, text: "日本語" },
  { id: 2, text: "全角混在ab" },
  { id: 3, text: "a" } // 1 文字。単位の違いが 1 と 2 で出る最小ケース
];

const conn = await DbConnection.connect({ host, user, password });
try {
  try { await executeStatement(conn, `DROP TABLE ${TABLE}`); } catch { /* 無ければ良い */ }
  // `C` は**混在 CCSID の CLOB**。宣言長がバイト数か文字数かは
  // **DBCS を含む値でしか判別できない**（SBCS だけだと一致してしまう）
  await executeStatement(conn, `CREATE TABLE ${TABLE} (ID INT NOT NULL, G DBCLOB(1K) CCSID 1200, C CLOB(1K))`);
  for (const r of ROWS) {
    await executeStatement(conn, `INSERT INTO ${TABLE} VALUES (${r.id}, CAST('${r.text}' AS DBCLOB(1K) CCSID 1200), CAST('${r.text}' AS CLOB(1K)))`);
  }
  log(`フィクスチャ: ${TABLE}（${ROWS.length} 行）\n`);

  // **retrieveLobData の応答を生で覗く**。長さの単位はここでしか分からない
  const orig = conn.request.bind(conn);
  const seen = [];
  conn.request = async (o) => {
    const r = await orig(o);
    if (o.reqId === 0x1816) {
      for (const p of r.params ?? []) {
        // 0x380f = lobData（先頭 2 バイト CCSID / 続く 4 バイト 長さ / 以降 本体）
        if (p.cp === 0x380f) seen.push(p.value);
      }
    }
    return r;
  };

  const res = await query(conn, `SELECT ID, G FROM ${TABLE} ORDER BY ID`, { lob: { maxBytes: 4096 } });
  for (let i = 0; i < res.rows.length; i++) {
    const row = res.rows[i];
    const want = ROWS[i];
    const v = row.G;
    const got = typeof v.value === "string" ? v.value : null;
    log(`### ID=${want.id} 期待 "${want.text}"（${want.text.length} 文字 / ${want.text.length * 2} バイト）`);
    log(`  返り値: ${got !== null ? `"${got}"（${got.length} 文字）` : `<bytes ${v.value?.length ?? 0}>`}`);
    log(`  byteLength=${v.byteLength} unavailable=${v.unavailable ?? "-"}`);
    const raw = seen[i];
    if (raw) {
      const view = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
      const ccsid = view.getUint16(0);
      const declared = view.getUint32(2);
      const payload = raw.subarray(6);
      log(`  生の lobData: ccsid=${ccsid} 宣言長=${declared} 実際の本体=${payload.length} バイト`);
      log(`    本体 hex: ${hex(payload.subarray(0, 24))}`);
      log(`    → 宣言長は ${declared === want.text.length ? "【文字数】" : declared === want.text.length * 2 ? "【バイト数】" : "?"}`);
    }
    log("");
  }

  // ---- 混在 CCSID の CLOB でも単位を確かめる ----
  log("=== 混在 CCSID の CLOB（DBCS を含む） ===");
  seen.length = 0;
  const res2 = await query(conn, `SELECT ID, C FROM ${TABLE} ORDER BY ID`, { lob: { maxBytes: 4096 } });
  for (let i = 0; i < res2.rows.length; i++) {
    const v = res2.rows[i].C;
    const want = ROWS[i];
    const got = typeof v.value === "string" ? v.value : null;
    log(`### ID=${want.id} 期待 "${want.text}"`);
    log(`  返り値: ${got !== null ? `"${got}"（${got.length} 文字）` : `<bytes ${v.value?.length ?? 0}>`} byteLength=${v.byteLength}`);
    const raw = seen[i];
    if (raw) {
      const view = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
      log(`  生: ccsid=${view.getUint16(0)} 宣言長=${view.getUint32(2)} 本体=${raw.length - 6} バイト`);
      log(`    本体 hex: ${hex(raw.subarray(6, 30))}`);
    }
  }
} finally {
  conn.close();
}
