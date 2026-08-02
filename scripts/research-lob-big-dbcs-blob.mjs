// **純 DBCS（CCSID 300）と BLOB の 64KB 超**を実機で詰める（`20260802-lob-big-dbcs-blob`）。
//
// `20260802-lob-multi-segment`（PR #289）で分割受信の単位を直したが、実機で測ったのは
// **UTF-16（1200）と混在 CLOB** の 2 系統だけ。残りは「`isTwoByteCcsid` が同じ枝だから
// 同じ道を通るはず」という**判断で押した**——それは事実ではない。
//
// 詰めたい事実:
//   F1. CCSID 300 の値を**倍々に伸ばせるか**（`G || G` に変換が要るか）
//   F2. 純 DBCS の 64KB 超で、往復の単位と中身が UTF-16 と同じか
//   F3. BLOB（CCSID 0）の 64KB 超で、**バイト列のまま**返るか（文字列に化けないか）
//
// 実行: AS400_HOST=... AS400_USER=... AS400_PASSWORD=... node --env-file=.env \
//         scripts/research-lob-big-dbcs-blob.mjs
//
// 副作用: 自分のライブラリーに表を 1 つ作り、**finally で必ず消す**。
import { DbConnection, executeStatement, query } from "@ts5250/hostserver";

const host = process.env.AS400_HOST;
const user = process.env.AS400_USER;
const password = process.env.AS400_PASSWORD;
if (!host || !user || !password) {
  process.stderr.write("AS400_HOST / AS400_USER / AS400_PASSWORD を環境変数で渡してください\n");
  process.exit(2);
}

const LIB = process.env.AS400_LIB ?? "TESTLIB";
const TABLE = `${LIB}.LOBBIG`;
/** 純 DBCS の CCSID。16684 は**この実機に変換表が無い**（`20260801-pure-dbcs-dbclob`） */
const DBCS_CCSID = process.env.AS400_DBCS_CCSID ?? "300";
const log = (s) => process.stdout.write(s + "\n");
const hex = (b, n = 16) => [...b.slice(0, n)].map((x) => x.toString(16).padStart(2, "0")).join(" ");

const TARGET_BYTES = 200_000;
const SEED_G = "あいうえおかきく"; // 8 文字 = 16 バイト（純 DBCS も 2 バイト/文字）
const SEED_B = "0123456789ABCDEF"; // 16 進リテラル 8 バイトぶん

const CP = { requestedSize: 0x3819, startOffset: 0x381a, dataLength: 0x3810, data: 0x380f };
const u32 = (b) => new DataView(b.buffer, b.byteOffset, b.byteLength).getUint32(0);

const conn = await DbConnection.connect({ host, user, password });

/** `0x1816` の往復を覗く */
const calls = [];
const orig = conn.request.bind(conn);
conn.request = async (o) => {
  const r = await orig(o);
  if (o.reqId === 0x1816) {
    const c = {};
    for (const p of o.params ?? []) {
      if (p.cp === CP.requestedSize) c.want = u32(p.value);
      if (p.cp === CP.startOffset) c.offset = u32(p.value);
    }
    for (const p of r.params ?? []) {
      if (p.cp === CP.dataLength) c.declared = p.value.length >= 6 ? u32(p.value.subarray(2)) : 0;
      if (p.cp === CP.data) {
        const v = new DataView(p.value.buffer, p.value.byteOffset, p.value.byteLength);
        c.ccsid = v.getUint16(0);
        c.lenField = v.getUint32(2);
        c.bodyBytes = p.value.length - 6;
        c.head = hex(p.value.subarray(6), 10);
      }
    }
    calls.push(c);
  }
  return r;
};

try {
  try { await executeStatement(conn, `DROP TABLE ${TABLE}`); } catch { /* 無ければ良い */ }
  await executeStatement(
    conn,
    `CREATE TABLE ${TABLE} (ID INT NOT NULL, P DBCLOB(1M) CCSID ${DBCS_CCSID}, B BLOB(1M))`
  );

  // ---- F1: 種を入れる（**直接の変換が無いので 1200 を経由する**）----
  log(`### F1. CCSID ${DBCS_CCSID} の値を作る`);
  try {
    await executeStatement(
      conn,
      `INSERT INTO ${TABLE} VALUES (1, ` +
        `CAST(CAST('${SEED_G}' AS DBCLOB(1M) CCSID 1200) AS DBCLOB(1M) CCSID ${DBCS_CCSID}), ` +
        `CAST(X'${SEED_B}' AS BLOB(1M)))`
    );
    log("  種を入れた（1200 経由の二段キャスト）");
  } catch (e) {
    log(`  **失敗**: ${e?.message ?? e}`);
    throw e;
  }

  // 倍々に伸ばす。**同じ CCSID どうしの連結に変換が要るか**がここで分かる
  let rounds = 0;
  for (let i = 0; i < 16; i++) {
    try {
      await executeStatement(conn, `UPDATE ${TABLE} SET P = P || P, B = B || B WHERE ID = 1`);
      rounds++;
    } catch (e) {
      log(`  **${i + 1} 回目の連結で失敗**: ${e?.message ?? e}`);
      break;
    }
    const m = await query(conn, `SELECT OCTET_LENGTH(P) AS PB, OCTET_LENGTH(B) AS BB FROM ${TABLE}`);
    if (Number(m.rows[0].PB) >= TARGET_BYTES && Number(m.rows[0].BB) >= TARGET_BYTES) break;
  }
  const sz = (
    await query(conn, `SELECT OCTET_LENGTH(P) AS PB, LENGTH(P) AS PC, OCTET_LENGTH(B) AS BB FROM ${TABLE}`)
  ).rows[0];
  log(`  連結 ${rounds} 回 → P: ${sz.PB} バイト / ${sz.PC} 文字、B: ${sz.BB} バイト\n`);

  // ---- F2: 純 DBCS の分割受信 ----
  log(`### F2. DBCLOB(CCSID ${DBCS_CCSID}) を上限 ${TARGET_BYTES} バイトで取る`);
  {
    calls.length = 0;
    const cell = (await query(conn, `SELECT P FROM ${TABLE} WHERE ID = 1`, { lob: { maxBytes: TARGET_BYTES } }))
      .rows[0].P;
    for (const c of calls) {
      log(`    want=${c.want} offset=${c.offset} → ccsid=${c.ccsid} lenField=${c.lenField} body=${c.bodyBytes}B declared=${c.declared} [${c.head}]`);
    }
    const v = cell?.value;
    log(`  型: ${typeof v === "string" ? `文字列 ${v.length} 文字` : `バイト列 ${v?.length ?? 0}`}`);
    log(`  byteLength=${cell?.byteLength} unavailable=${cell?.unavailable ?? "(なし)"}`);
    if (typeof v === "string") {
      let bad = -1;
      for (let i = 0; i < v.length; i++) if (v[i] !== SEED_G[i % SEED_G.length]) { bad = i; break; }
      log(`  先頭16: ${JSON.stringify(v.slice(0, 16))}`);
      log(`  連続性: ${bad < 0 ? "OK" : `**NG** — ${bad} 文字目で食い違う`}`);
    }
  }

  // ---- F3: BLOB ----
  log(`\n### F3. BLOB を上限 ${TARGET_BYTES} バイトで取る`);
  {
    calls.length = 0;
    const cell = (await query(conn, `SELECT B FROM ${TABLE} WHERE ID = 1`, { lob: { maxBytes: TARGET_BYTES } }))
      .rows[0].B;
    for (const c of calls) {
      log(`    want=${c.want} offset=${c.offset} → ccsid=${c.ccsid} lenField=${c.lenField} body=${c.bodyBytes}B declared=${c.declared} [${c.head}]`);
    }
    const v = cell?.value;
    log(`  型: ${typeof v === "string" ? `**文字列** ${v.length} 文字（化けている）` : `バイト列 ${v?.length ?? 0}`}`);
    log(`  byteLength=${cell?.byteLength} unavailable=${cell?.unavailable ?? "(なし)"}`);
    if (v instanceof Uint8Array) {
      const seed = Uint8Array.from(SEED_B.match(/../g).map((h) => parseInt(h, 16)));
      let bad = -1;
      for (let i = 0; i < v.length; i++) if (v[i] !== seed[i % seed.length]) { bad = i; break; }
      log(`  先頭16: ${hex(v)}`);
      log(`  連続性: ${bad < 0 ? "OK" : `**NG** — ${bad} バイト目で食い違う`}`);
    }
  }

  // ---- 参考: 打ち切り ----
  log("\n### 打ち切り（上限 40,000 バイト）");
  for (const col of ["P", "B"]) {
    const cell = (await query(conn, `SELECT ${col} FROM ${TABLE} WHERE ID = 1`, { lob: { maxBytes: 40_000 } }))
      .rows[0][col];
    const v = cell?.value;
    const bytes = typeof v === "string" ? v.length * 2 : (v?.length ?? 0);
    log(`  ${col}: ${bytes} バイト相当 / unavailable=${cell?.unavailable ?? "(なし)"}`);
  }
} catch (e) {
  log(`例外: ${e?.stack ?? e}`);
} finally {
  try { await executeStatement(conn, `DROP TABLE ${TABLE}`); } catch { /* 良い */ }
  conn.close?.();
}
