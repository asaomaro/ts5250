// SEU の PageUp/PageDown 境界ページでのカーソル挙動を調べるための、複数ページ分の長さを持つ
// ソースメンバーを実機に作る。
//   <LIB>/QCLSRC(PAGECURS) … 各行に埋め込みの行番号を持つ、識別しやすいダミーソース
//
// **確かめたいこと（呼び出し元）**: .aidev/works/20260914-seu-page-cursor-hold/research.md
// 境界ページ（先頭/最終ページ）到達時、ホストが送るWTDにIC/MCが含まれるか。
//
// 実行: node --env-file=.env --env-file=.env.verify scripts/build-pagecurs.mjs
import { CommandConnection } from "@ts5250/hostserver";

const LIB = process.env.AS400_LIB ?? "TESTLIB";
const log = (s) => process.stdout.write(s + "\n");

// 80 行。SEU の1画面あたりの表示行数（十数行程度）に対して十分な複数ページ分。
// 内容は ASCII のみ（RUNSQL の文字リテラルが実機のジョブ CCSID へ変換できず SQL0330 で落ちるのを避ける）。
const LINES = Array.from({ length: 80 }, (_, i) => `* LINE ${String(i + 1).padStart(4, "0")}`);

const host = process.env.AS400_HOST, user = process.env.AS400_USER, password = process.env.AS400_PASSWORD;
if (!host || !user || !password) { log("AS400_HOST / AS400_USER / AS400_PASSWORD を環境変数で"); process.exit(1); }

const connect = async () => {
  for (let a = 1; ; a++) {
    try {
      return await CommandConnection.connect({ host, user, password, resolvePort: true, timeoutMs: 40_000 });
    } catch (e) {
      if (a >= 4) throw e;
      log(`(接続やり直し ${a}: ${e.code})`);
      await new Promise((r) => setTimeout(r, 5000));
    }
  }
};
const cn = await connect();
const show = (r, label) => {
  const bad = r.messages.filter((m) => m.kind === "error" || m.kind === "severe");
  log(`${r.success ? "OK  " : "NG  "} ${label}`);
  for (const m of bad) log(`      ${m.id} ${m.text}`);
  return r.success;
};
const run = async (cmd, label = cmd) => show(await cn.run(cmd), label);

async function putSource(file, member, lines, srcType) {
  await cn.run(`DLTF FILE(${LIB}/QTMPSRC)`);
  if (!await run(`CRTSRCPF FILE(${LIB}/QTMPSRC) RCDLEN(112) MBR(QTMPSRC)`)) return false;
  const BATCH = 8;
  for (let i = 0; i < lines.length; i += BATCH) {
    const chunk = lines.slice(i, i + BATCH);
    const values = chunk.map((line, j) => `(${i + j + 1}.00,0,''${line.replace(/'/g, "''''")}'')`).join(",");
    if (!await run(
      `RUNSQL SQL('INSERT INTO ${LIB}.QTMPSRC (SRCSEQ,SRCDAT,SRCDTA) VALUES ${values}') COMMIT(*NONE) DECMPT(*PERIOD)`,
      `  行${i + 1}〜${i + chunk.length}`
    )) return false;
  }
  await cn.run(`CRTSRCPF FILE(${LIB}/${file}) RCDLEN(112)`);
  await cn.run(`RMVM FILE(${LIB}/${file}) MBR(${member})`);
  await cn.run(`ADDPFM FILE(${LIB}/${file}) MBR(${member}) SRCTYPE(${srcType})`);
  return await run(`CPYF FROMFILE(${LIB}/QTMPSRC) TOFILE(${LIB}/${file}) FROMMBR(QTMPSRC) TOMBR(${member}) MBROPT(*REPLACE) FMTOPT(*NOCHK)`, `  ${file}(${member}) へ複写`);
}

log("== PAGECURS（80行のダミーソース） ==");
if (!await putSource("QCLSRC", "PAGECURS", LINES, "TXT")) process.exit(1);

log("done");
process.exit(0);
