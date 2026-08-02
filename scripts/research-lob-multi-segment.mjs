// **64KB を超える LOB の分割受信**を実機で詰める（`20260802-lob-multi-segment`）。
//
// `retrieveLob`（`packages/hostserver/src/db/lob.ts`）は 1 応答に収まらない LOB を
// **開始オフセットを進めて繰り返し**取る。ところが PR #248 / #251 は
// **1 応答に収まる値でしか測っていない**——この分岐を一度も通していない。
//
// 詰めたい事実は 3 つ:
//   F1. `lobStartOffset` の単位は【文字】か【バイト】か
//   F2. `lobRequestedSize` の単位は【文字】か【バイト】か
//   F3. 上限で打ち切ったとき、取れた中身は**先頭から連続**しているか
//
// **SBCS だけで測っても分からない**（文字数＝バイト数で一致してしまう）。
// 2 バイト CCSID（UTF-16 = 1200）で測るのがこのスクリプトの要点。
//
// 実行: AS400_HOST=... AS400_USER=... AS400_PASSWORD=... node --env-file=.env \
//         scripts/research-lob-multi-segment.mjs
//
// 副作用: 自分のライブラリーに表を 1 つ作り、**finally で必ず消す**。
import { DbConnection, executeStatement, query, retrieveLob } from "@ts5250/hostserver";

const host = process.env.AS400_HOST;
const user = process.env.AS400_USER;
const password = process.env.AS400_PASSWORD;
if (!host || !user || !password) {
  process.stderr.write("AS400_HOST / AS400_USER / AS400_PASSWORD を環境変数で渡してください\n");
  process.exit(2);
}

const LIB = process.env.AS400_LIB ?? "TESTLIB";
const TABLE = `${LIB}.LOBSEG`;
const log = (s) => process.stdout.write(s + "\n");
const hex = (b, n = 16) => [...b.slice(0, n)].map((x) => x.toString(16).padStart(2, "0")).join(" ");

/** 目標サイズ（バイト）。`SEGMENT_BYTES = 0xffff` を確実に跨がせる */
const TARGET_BYTES = 200_000;

const CP = {
  locator: 0x3818,
  requestedSize: 0x3819,
  startOffset: 0x381a,
  dataLength: 0x3810,
  data: 0x380f
};
const u32 = (b) => new DataView(b.buffer, b.byteOffset, b.byteLength).getUint32(0);

const conn = await DbConnection.connect({ host, user, password });

/** `0x1816` の要求と応答を覗く。**単位はここでしか分からない** */
const calls = [];
const orig = conn.request.bind(conn);
conn.request = async (o) => {
  const r = await orig(o);
  if (o.reqId === 0x1816) {
    const req = {};
    for (const p of o.params ?? []) {
      if (p.cp === CP.requestedSize) req.want = u32(p.value);
      if (p.cp === CP.startOffset) req.offset = u32(p.value);
      if (p.cp === CP.locator) req.locator = u32(p.value);
    }
    const res = {};
    for (const p of r.params ?? []) {
      if (p.cp === CP.dataLength) res.declared = p.value.length >= 6 ? u32(p.value.subarray(2)) : 0;
      if (p.cp === CP.data) {
        const v = new DataView(p.value.buffer, p.value.byteOffset, p.value.byteLength);
        res.ccsid = v.getUint16(0);
        res.lenField = v.getUint32(2);
        res.bodyBytes = p.value.length - 6;
        res.head = hex(p.value.subarray(6), 12);
      }
    }
    calls.push({ ...req, ...res });
  }
  return r;
};

/** 中身の一致を測る。**バイト列で見る**（文字列比較だと復号の失敗と混ざる） */
function utf8(s) {
  return new TextEncoder().encode(s);
}

try {
  try { await executeStatement(conn, `DROP TABLE ${TABLE}`); } catch { /* 無ければ良い */ }
  // `G` は UTF-16（2 バイト CCSID）／`C` は SBCS。**同じ操作を両方に当てて差を見る**
  await executeStatement(
    conn,
    `CREATE TABLE ${TABLE} (ID INT NOT NULL, C CLOB(1M), G DBCLOB(1M) CCSID 1200)`
  );
  // 種を入れて**倍々に伸ばす**。SQL 文の長さ制限に当たらないので大きな値を作れる。
  // 種は 8 文字ずつ——先頭からの連続性を後で目視できるよう、繰り返しが見える形にする
  await executeStatement(
    conn,
    `INSERT INTO ${TABLE} VALUES (1, CAST('ABCDEFGH' AS CLOB(1M)), CAST('あいうえおかきく' AS DBCLOB(1M) CCSID 1200))`
  );
  for (let i = 0; i < 15; i++) {
    await executeStatement(conn, `UPDATE ${TABLE} SET C = C || C, G = G || G WHERE ID = 1`);
    const m = await query(conn, `SELECT OCTET_LENGTH(C) AS CB, LENGTH(G) AS GC, OCTET_LENGTH(G) AS GB FROM ${TABLE}`);
    const r = m.rows[0];
    if (Number(r.CB) >= TARGET_BYTES && Number(r.GB) >= TARGET_BYTES) break;
  }
  const sz = (await query(conn, `SELECT OCTET_LENGTH(C) AS CB, LENGTH(C) AS CC, OCTET_LENGTH(G) AS GB, LENGTH(G) AS GC FROM ${TABLE}`)).rows[0];
  log(`フィクスチャ: ${TABLE}`);
  log(`  C (CLOB SBCS)      : ${sz.CB} バイト / ${sz.CC} 文字`);
  log(`  G (DBCLOB CCSID1200): ${sz.GB} バイト / ${sz.GC} 文字  ← **バイト = 文字 × 2**`);
  log("");

  // 期待値（先頭からの繰り返し）
  const expectC = utf8("ABCDEFGH".repeat(Number(sz.CC) / 8));
  const expectGChars = "あいうえおかきく".repeat(Number(sz.GC) / 8);

  // ---- F1/F2: ロケーターを取り、分割受信の往復を覗く ----
  for (const col of ["C", "G"]) {
    log(`### ${col} を分割受信する（maxBytes=${TARGET_BYTES}）`);
    calls.length = 0;
    const res = await query(conn, `SELECT ${col} FROM ${TABLE} WHERE ID = 1`, {
      lob: { maxBytes: TARGET_BYTES }
    });
    const cell = res.rows[0][col];
    log(`  往復 ${calls.length} 回`);
    for (const c of calls.slice(0, 6)) {
      log(`    want=${c.want} offset=${c.offset} → ccsid=${c.ccsid} lenField=${c.lenField} body=${c.bodyBytes}B declared=${c.declared} [${c.head}]`);
    }
    if (calls.length > 6) log(`    … 他 ${calls.length - 6} 回`);
    const got = typeof cell?.value === "string" ? utf8(cell.value) : cell?.value;
    const gotLen = got?.length ?? 0;
    log(`  byteLength(申告)=${cell?.byteLength} unavailable=${cell?.unavailable ?? "(なし)"}`);
    log(`  取れた値: ${typeof cell?.value === "string" ? `文字列 ${cell.value.length} 文字` : `${gotLen} バイト`}`);
    if (col === "C") {
      const ok = typeof cell?.value === "string" && cell.value === "ABCDEFGH".repeat(Number(sz.CC) / 8);
      log(`  中身一致: ${ok ? "OK" : "**NG**"}`);
      if (!ok && typeof cell?.value === "string") {
        log(`    期待 先頭32: ${JSON.stringify("ABCDEFGH".repeat(4))}`);
        log(`    実際 先頭32: ${JSON.stringify(cell.value.slice(0, 32))}`);
        log(`    実際 長さ  : ${cell.value.length}（期待 ${sz.CC}）`);
      }
    } else {
      const ok = typeof cell?.value === "string" && cell.value === expectGChars;
      log(`  中身一致: ${ok ? "OK" : "**NG**"}`);
      if (typeof cell?.value === "string") {
        log(`    期待 先頭16: ${JSON.stringify(expectGChars.slice(0, 16))}`);
        log(`    実際 先頭16: ${JSON.stringify(cell.value.slice(0, 16))}`);
        log(`    実際 長さ  : ${cell.value.length} 文字（期待 ${sz.GC}）`);
        // **どこで飛んだか**を出す。オフセットの単位違いなら規則的にずれる
        let firstBad = -1;
        for (let i = 0; i < Math.min(cell.value.length, expectGChars.length); i++) {
          if (cell.value[i] !== expectGChars[i]) { firstBad = i; break; }
        }
        log(`    最初に食い違う位置: ${firstBad < 0 ? "(無し)" : `${firstBad} 文字目 = ${firstBad * 2} バイト目`}`);
      }
    }
    log("");
  }
  void expectC;

  // ---- F3: 打ち切り（too-large）----
  for (const col of ["C", "G"]) {
    const cap = 40_000; // 中身より小さく、かつ 1 セグメントに収まる値
    log(`### ${col} を上限 ${cap} バイトで打ち切る`);
    calls.length = 0;
    const res = await query(conn, `SELECT ${col} FROM ${TABLE} WHERE ID = 1`, { lob: { maxBytes: cap } });
    const cell = res.rows[0][col];
    log(`  往復 ${calls.length} 回 / unavailable=${cell?.unavailable ?? "(なし)"} byteLength=${cell?.byteLength}`);
    const v = cell?.value;
    if (typeof v === "string") {
      const head = col === "C" ? "ABCDEFGH" : "あいうえおかきく";
      const cont = v.startsWith(head) && v.slice(0, 32) === head.repeat(4).slice(0, 32);
      log(`  取れた: ${v.length} 文字 / 先頭が連続: ${cont ? "OK" : "**NG**"}`);
      log(`  先頭16: ${JSON.stringify(v.slice(0, 16))}`);
    } else {
      log(`  取れた: ${v?.length ?? 0} バイト（文字列に復号されていない）`);
    }
    log("");
  }

  // ---- 参考: retrieveLob を直接叩いて生の戻りを見る ----
  log("### retrieveLob を直接叩く（G / maxBytes=200000）");
  const r2 = await query(conn, `SELECT G FROM ${TABLE} WHERE ID = 1`, { lob: { maxBytes: 0 } });
  const loc = r2.rows[0].G?.locator;
  log(`  locator=${loc}`);
  if (loc) {
    calls.length = 0;
    const got = await retrieveLob(conn, loc, { maxBytes: TARGET_BYTES });
    log(`  bytes=${got.bytes.length} totalLength=${got.totalLength} ccsid=${got.ccsid} truncated=${got.truncated}`);
    log(`  往復 ${calls.length} 回`);
    for (const c of calls.slice(0, 6)) {
      log(`    want=${c.want} offset=${c.offset} → lenField=${c.lenField} body=${c.bodyBytes}B`);
    }
  }
} catch (e) {
  log(`例外: ${e?.stack ?? e}`);
} finally {
  try { await executeStatement(conn, `DROP TABLE ${TABLE}`); } catch { /* 良い */ }
  conn.close?.();
}
