// 実機に **Unicode の欄（DDS の `CCSID` キーワード）を持つ画面** を出す試験画面を作る（`20260922` 調査 R11 の M4）。
//
//   UNIDSPF（DDS）と UNITST（ILE C。`scripts/host-src/unitst.c`）。`CALL <LIB>/UNITST [PARM('SBA')]`: UNIREC（`SBA` なら SBAREC＝1 行 1 桁の入力欄）を出し、戻った入力の生バイトを IFS のログへ残す。
//   **CL の DCLF は使えない**（Unicode の欄を含む表示装置ファイルで CRTBNDCL が CPF0820 で落ちる。詳細は listing 側で未確認）。C のレコード入出力なら通る
//   欄: FA（A・比較用の通常の欄）／FG1（G・CCSID(13488)）／FG2（G・CCSID(1200)）／FGP（G・CCSID 無しの DBCS グラフィック。対照）
//   **A 型に CCSID(…) を付けると DDS のコンパイルが落ちる**（GENLVL のエラー。37・930・1200・1399・13488 で確認）。G 型なら CCSID(13488)・CCSID(1200) が通る
//   ホストが**申告の無いクライアントにも** FCW 0x90xx〜0x93xx・WDSF 0x54 を送るかを、送られた WTD の生バイトで確かめる。
//
// **ソースは既存の QDDSSRC に入れる**（新しいソース・ファイルは作らない。`scripts/build-ulktest.mjs` と同じ方式）。
// **測定が済んだら `--clean` で消す**（DLTPGM / DLTF / RMVM と IFS のファイル。別名は通常の実行の中で作って落とす）。
//
// 実行: node --env-file=.env --env-file=.env.verify scripts/build-unitest.mjs [--clean]
//   AS400_HOST / AS400_USER / AS400_PASSWORD（`.env`）、AS400_LIB（`.env.verify`）。資格情報は出力しない。
import { readFileSync } from "node:fs";
import { Session5250 } from "@ts5250/tn5250";
import { CommandConnection, IfsConnection } from "@ts5250/hostserver";

const host = process.env.AS400_HOST, user = process.env.AS400_USER, password = process.env.AS400_PASSWORD;
const LIB = process.env.AS400_LIB ?? "TESTLIB", DDSF = "QDDSSRC";
if (!host || !user || !password) { process.stderr.write("AS400_HOST / AS400_USER / AS400_PASSWORD が要ります（.env）\n"); process.exit(2); }
const ccsid = Number(process.env.AS400_CCSID ?? 930);
const CLEAN = process.argv.includes("--clean");
const log = (s) => process.stderr.write(s + "\n");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rows = (s) => s.cells.map((r) => r.map((c) => c.char).join("").replace(/\s+$/, ""));

// ---- DDS 桁組み立て（build-sgntest.mjs と同じ規則）----
const put = (b, p, str) => { const a = b.split(""); for (let i = 0; i < str.length; i++) a[p - 1 + i] = str[i]; return a.join(""); };
const blank = () => " ".repeat(80);
const kwd = (kw) => put(put(blank(), 6, "A"), 45, kw).replace(/ +$/, "");
const rec = (n) => put(put(put(blank(), 6, "A"), 17, "R"), 19, n).replace(/ +$/, "");
const constant = (r, c, t) => put(put(put(put(blank(), 6, "A"), 39, String(r).padStart(3)), 42, String(c).padStart(3)), 45, `'${t}'`).replace(/ +$/, "");
function field(name, len, shift, usage, r, c, kw = "") {
  let l = put(put(blank(), 6, "A"), 19, name);
  l = put(l, 35 - String(len).length, String(len));
  if (shift) l = put(l, 35, shift);
  l = put(put(put(l, 38, usage), 39, String(r).padStart(3)), 42, String(c).padStart(3));
  if (kw) l = put(l, 45, kw);
  return l.replace(/ +$/, "");
}
const DDS = [
  rec("UNIREC"), kwd("CA03(03)"),
  constant(1, 3, "UNICODE FIELD TEST"),
  constant(3, 3, "PLAIN A:"), field("FA", 10, "A", "B", 3, 20),
  constant(5, 3, "G 13488:"), field("FG1", 10, "G", "B", 5, 20, "CCSID(13488)"),
  constant(7, 3, "G 1200:"), field("FG2", 10, "G", "B", 7, 20, "CCSID(1200)"),
  constant(9, 3, "G PLAIN:"), field("FGP", 10, "G", "B", 9, 20),
  // SBAREC: **1 行 1 桁に入力欄を置く**（属性の桁が 1 行 0 桁になる。R11 の M3。ホストが SBA(1,0) を出すか）
  rec("SBAREC"),
  field("FX", 6, "A", "B", 1, 1),
  constant(3, 3, "SBA REC")
];

async function run(session, cmd, timeoutMs = 30000) {
  const s = session.snapshot();
  const cf = s.fields.filter((f) => !f.protected).slice(-1)[0];
  session.setField({ index: cf.index }, cmd);
  await session.sendAid("Enter", { cursor: { row: cf.row, col: cf.col }, timeoutMs });
  await sleep(500);
  return session.snapshot();
}
const lastMsg = (snap) => rows(snap).slice(-2).map((x) => x.trim()).filter(Boolean).join(" / ");
const runSql = (session, sql) => run(session, `RUNSQL SQL('${sql.replace(/'/g, "''")}') COMMIT(*NONE)`);
async function injectMember(session, mbr, type, alias, lines) {
  await run(session, `RMVM FILE(${LIB}/${DDSF}) MBR(${mbr})`);
  await run(session, `ADDPFM FILE(${LIB}/${DDSF}) MBR(${mbr}) SRCTYPE(${type})`);
  await runSql(session, `DROP ALIAS ${LIB}/${alias}`);
  await runSql(session, `CREATE ALIAS ${LIB}/${alias} FOR ${LIB}/${DDSF}(${mbr})`);
  // **順序番号（SRCSEQ）を振る**。DDS は 0 のままでも通るが、CL のコンパイラーは昇順でないと
  // CPD0780（ソースの順序番号が正しくない）で落ちる（実機で踏んだ）
  let seq = 0;
  for (const l of lines) {
    seq += 1;
    // 列名を書かない（ソース PF の列は SRCSEQ・SRCDAT・SRCDTA の順）——コマンド行（153 バイト）に収めるため
    const sql = `INSERT INTO ${LIB}/${alias} VALUES(${seq},0,'${l.replace(/'/g, "''")}')`;
    await runSql(session, sql);
  }
  await runSql(session, `DROP ALIAS ${LIB}/${alias}`);
}

const s = await Session5250.connect({ host, ccsid, warn: () => {} });
await sleep(800);
const inputs = s.snapshot().fields.filter((f) => !f.protected);
s.setField({ index: inputs[0].index }, user);
s.setField({ index: inputs[1].index }, password);
await s.sendAid("Enter", { cursor: { row: inputs[0].row, col: inputs[0].col }, timeoutMs: 15000 });
for (let i = 0; i < 6; i++) {
  await sleep(800);
  const t = rows(s.snapshot());
  if (t.some((r) => /===>/.test(r))) break;
  if (t.some((r) => r.includes("対話式ジョブの回復"))) {
    const f = s.snapshot().fields.filter((x) => !x.protected).slice(-1)[0];
    s.setField({ index: f.index }, "90");
    await s.sendAid("Enter", { cursor: { row: f.row, col: f.col }, timeoutMs: 12000 });
  } else await s.sendAid("Enter", { timeoutMs: 10000 });
}
const STMF = "/tmp/unitst.c", LOGF = "/tmp/unitst.log";
try {
  if (CLEAN) {
    for (const c of [`DLTPGM PGM(${LIB}/UNITST)`, `DLTF FILE(${LIB}/UNIDSPF)`, `RMVM FILE(${LIB}/${DDSF}) MBR(UNIDSPF)`]) {
      log(`${c}: ${lastMsg(await run(s, c))}`);
    }
    log(`CHKOBJ UNITST: ${lastMsg(await run(s, `CHKOBJ OBJ(${LIB}/UNITST) OBJTYPE(*PGM)`))}`);
    log(`CHKOBJ UNIDSPF: ${lastMsg(await run(s, `CHKOBJ OBJ(${LIB}/UNIDSPF) OBJTYPE(*FILE)`))}`);
    const ifs = await IfsConnection.connect({ host, user, password });
    for (const f of [STMF, LOGF]) { try { await ifs.deleteFile(f); log(`${f}: 消した`); } catch (e) { log(`${f}: ${String(e.message).slice(0, 60)}`); } }
    ifs.close?.();
  } else {
    await injectMember(s, "UNIDSPF", "DSPF", "UNIDA", DDS);
    await run(s, `DLTF FILE(${LIB}/UNIDSPF)`);
    log(`CRTDSPF: ${lastMsg(await run(s, `CRTDSPF FILE(${LIB}/UNIDSPF) SRCFILE(${LIB}/${DDSF}) SRCMBR(UNIDSPF)`, 40000))}`);
    const SOURCE = readFileSync(new URL("./host-src/unitst.c", import.meta.url), "utf8")
      .replaceAll("UNITST_LOG", JSON.stringify(LOGF)).replaceAll("UNITST_LIB", JSON.stringify(LIB));
    const ifs = await IfsConnection.connect({ host, user, password });
    await ifs.writeFile(STMF, new TextEncoder().encode(SOURCE), { create: true, dataCcsid: 1208 });
    ifs.close?.();
    const cmd = await CommandConnection.connect({ host, user, password });
    // CRTBNDC は失敗しても戻りコード 0 で返ることがある（`build-dscmd.mjs` の注記）——メッセージと CHKOBJ で確かめる
    const r = await cmd.run(`CRTBNDC PGM(${LIB}/UNITST) SRCSTMF('${STMF}') TGTCCSID(*JOB) SYSIFCOPT(*IFSIO) TEXT('Unicode field test')`);
    for (const m of (r.messages ?? []).slice(0, 8)) log(`  · ${`${m.id ?? ""} ${m.text ?? ""}`.replace(/\s+/g, " ").slice(0, 160)}`);
    cmd.close?.();
    log(`CHKOBJ UNITST: ${lastMsg(await run(s, `CHKOBJ OBJ(${LIB}/UNITST) OBJTYPE(*PGM)`))}`);
  }
} finally {
  await run(s, "SIGNOFF").catch(() => {});
  s.disconnect();
}
