// **記述（PCML）から呼べることを実機で確かめる。**
//
// `research-pcml-layout.mjs` は同じプログラムを**生バイトの手詰め**で呼んだ。
// ここは同じ値・同じ判定を**名前だけ**で行う——手詰めが消えたことを示すのが目的。
//
// 記述は**実機の IFS から読む**（コンパイラが `PGMINFO(*PCML)` で吐いたもの）。
//
// 実行: node --env-file=.env --env-file=.env.verify scripts/verify-pcml.mjs
// 前提: scripts/research-pcml.mjs で TESTLIB/PCMLTST と .pcml を作ってあること。
import {
  CommandConnection,
  IfsConnection,
  parsePcml,
  buildPcmlCall,
  readPcmlOutputs,
  toProgramParameters
} from "@ts5250/hostserver";

const LIB = process.env.AS400_LIB ?? "TESTLIB";
const host = process.env.AS400_HOST;
const user = process.env.AS400_USER;
const password = process.env.AS400_PASSWORD;
if (!host || !user || !password) { process.stderr.write("環境変数が足りません\n"); process.exit(2); }

const DIR = process.env.AS400_IFS_DIR ?? `/home/${user}`;
const STMF = `${DIR}/pcmltst.pcml`;
const CCSID = 37;
const log = (s) => process.stdout.write(s + "\n");
let pass = 0, fail = 0;
const check = (c, m) => { if (c) { pass++; log(`  PASS ${m}`); } else { fail++; log(`  FAIL ${m}`); } };

/** 生バイトを 1 つも組まない。**名前だけ** */
const VALUES = {
  "PCMLTST.INTXT": "HELLO",
  "PCMLTST.IONUM": "12.34",
  "PCMLTST.REC.ID": "0",
  "PCMLTST.REC.NM": "",
  "PCMLTST.REC.RATE": "0",
  "PCMLTST.ITEMS(1)": "",
  "PCMLTST.ITEMS(2)": "",
  "PCMLTST.ITEMS(3)": "",
  "PCMLTST.ITEMS(4)": "",
  "PCMLTST.CNT": "0",
  "PCMLTST.BIG": "0",
  "PCMLTST.AMT": "1.00"
};

const ifs = await IfsConnection.connect({ host, user, password });
const cmd = await CommandConnection.connect({ host, user, password });
try {
  log(`### 1. IFS から記述を読む: ${STMF}`);
  const got = await ifs.readTextFile(STMF);
  // コンパイラは 819 で書く（実測）。中身は ASCII の範囲なので 1 バイト 1 文字で読める
  let text = "";
  for (const b of got.data) text += String.fromCharCode(b);
  log(`  タグ=${got.ccsid ?? "なし"} / ${got.data.length} バイト`);

  const doc = parsePcml(text);
  const pgm = doc.programs.get("PCMLTST");
  check(Boolean(pgm), "PCMLTST の記述を読めた");
  check(pgm.fields.length === 7, `項目が 7 つ（実測 ${pgm.fields.length}）`);
  check(pgm.fields[2].fields?.length === 3, "REC が構造体として展開された");

  log("\n### 2. 名前だけで呼ぶ");
  const call = buildPcmlCall(doc, "PCMLTST", VALUES, { ccsid: CCSID });
  check(call.library === LIB, `呼び先は ${call.library}/${call.program}（path から解いた）`);
  check(call.args.length === 7, `引数は 7 本（実測 ${call.args.length}）`);

  const { result, outputs } = await cmd.call(call.program, call.library, toProgramParameters(call.args, { ccsid: CCSID }));
  check(result.success, `呼び出しが成功（${result.messages.map((m) => `${m.id} ${m.text}`).join(" / ") || "メッセージなし"}）`);
  if (!result.success) process.exit(1);

  const v = readPcmlOutputs(call, outputs);
  log("\n### 3. 名前で読む");
  check(v["PCMLTST.IONUM"] === "24.68", `PCMLTST.IONUM = 24.68（実測 ${v["PCMLTST.IONUM"]}）`);
  check(v["PCMLTST.REC.ID"] === "7", `PCMLTST.REC.ID = 7（実測 ${v["PCMLTST.REC.ID"]}）`);
  check(v["PCMLTST.REC.NM"]?.trim() === "REC:HELLO", `PCMLTST.REC.NM = REC:HELLO（実測 "${v["PCMLTST.REC.NM"]?.trim()}"）`);
  check(v["PCMLTST.REC.RATE"] === "1.5000", `PCMLTST.REC.RATE = 1.5000（実測 ${v["PCMLTST.REC.RATE"]}）`);
  const items = [1, 2, 3, 4].map((i) => v[`PCMLTST.ITEMS(${i})`]?.trim()).join(",");
  check(items === "AAA,BBB,CCC,DDD", `PCMLTST.ITEMS(1..4) = AAA,BBB,CCC,DDD（実測 ${items}）`);
  check(v["PCMLTST.CNT"] === "4", `PCMLTST.CNT = 4（実測 ${v["PCMLTST.CNT"]}）`);
  check(v["PCMLTST.BIG"] === "9000000000", `PCMLTST.BIG = 9000000000（実測 ${v["PCMLTST.BIG"]}）`);
  check(v["PCMLTST.AMT"] === "2.00", `PCMLTST.AMT = 2.00（実測 ${v["PCMLTST.AMT"]}）`);
  check(v["PCMLTST.INTXT"] === undefined, "入力専用の PCMLTST.INTXT は返らない");

  log(`\n${pass} PASS / ${fail} FAIL`);
  process.exitCode = fail === 0 ? 0 : 1;
} finally {
  ifs.close();
  cmd.close();
}
