// **PCML の宣言どおりのバイト並びで実機が受け取るか**を測る。
//
// `research-pcml.mjs` で吐かせた PCML はこう言っている:
//   INTXT char(10) / IONUM packed(9,2) / REC struct CUSTT / ITEMS char(5)×4 /
//   CNT int(4) / BIG int(8) / AMT zoned(7,2)
//
// ここで確かめたいのは**構造体と配列の実体**——
//   * 構造体は「メンバーを順に連結しただけ」か
//   * 配列は「同じ型を count 回並べただけ」か
// 生の `bytes` で組んで往復させ、RPG が書いた値が期待位置に現れるかを見る。
//
// 実行: node --env-file=.env scripts/research-pcml-layout.mjs
// 前提: research-pcml.mjs で TESTLIB/PCMLTST を作ってあること。
import { CommandConnection, toProgramParameters, fromProgramOutputs,
         packedByteLength, packedDecimalToString } from "@ts5250/hostserver";
import { codecForCcsid } from "@ts5250/ebcdic";

const host = process.env.AS400_HOST;
const user = process.env.AS400_USER;
const password = process.env.AS400_PASSWORD;
if (!host || !user || !password) { process.stderr.write("環境変数が足りません\n"); process.exit(2); }

const LIB = process.env.AS400_LIB ?? "TESTLIB";
const CCSID = 37;
const log = (s) => process.stdout.write(s + "\n");
let pass = 0, fail = 0;
const check = (c, m) => { if (c) { pass++; log(`  PASS ${m}`); } else { fail++; log(`  FAIL ${m}`); } };

const cp = codecForCcsid(CCSID);
const b64 = (u8) => Buffer.from(u8).toString("base64");
const un64 = (s) => new Uint8Array(Buffer.from(s, "base64"));

// PCML の宣言から組んだ **REC（struct CUSTT）** の中身: ID packed(7,0) / NM char(20) / RATE packed(9,4)
const REC_LEN = packedByteLength(7) + 20 + packedByteLength(9);
const rec = new Uint8Array(REC_LEN);
rec.set(cp.encode(" ".repeat(20)).bytes, packedByteLength(7));   // NM は空白
rec[packedByteLength(7) - 1] = 0x0f;                              // ID = 0（正）
rec[REC_LEN - 1] = 0x0f;                                          // RATE = 0（正）

const items = cp.encode(" ".repeat(20)).bytes;                    // char(5) × 4

const args = [
  { type: "char",   dir: "in",    value: "HELLO",  length: 10 },
  { type: "packed", dir: "inout", value: "12.34",  digits: 9, decimals: 2 },
  { type: "bytes",  dir: "inout", value: b64(rec),   length: REC_LEN },
  { type: "bytes",  dir: "inout", value: b64(items), length: 20 },
  { type: "bin",    dir: "inout", value: "0", bytes: 4 },
  { type: "bin",    dir: "inout", value: "0", bytes: 8 },
  { type: "zoned",  dir: "inout", value: "1.00", digits: 7, decimals: 2 }
];

const conn = await CommandConnection.connect({ host, user, password });
try {
  log(`### ${LIB}/PCMLTST を PCML の宣言どおりに組んで呼ぶ`);
  log(`  REC は ${REC_LEN} バイト（packed(7,0)=${packedByteLength(7)} + char(20)=20 + packed(9,4)=${packedByteLength(9)}）`);
  const { result, outputs } = await conn.call("PCMLTST", LIB, toProgramParameters(args, { ccsid: CCSID }));
  log(`  戻り: ${result.success ? "成功" : "失敗"} ${result.messages.map((m) => `${m.id} ${m.text}`).join(" / ")}`);
  if (!result.success) process.exit(1);

  const vals = fromProgramOutputs(args, outputs, { ccsid: CCSID });
  log("\n### 判定");
  check(vals[1] === "24.68", `IONUM = 12.34 × 2 = 24.68（実測 ${vals[1]}）`);

  const gotRec = un64(vals[2]);
  const id   = packedDecimalToString(gotRec, 0, 7, 0);
  const nm   = cp.decode(gotRec.subarray(packedByteLength(7), packedByteLength(7) + 20));
  const rate = packedDecimalToString(gotRec, packedByteLength(7) + 20, 9, 4);
  check(id === "7",        `REC.ID = 7（実測 ${id}）——構造体は連結**である**`);
  check(nm.trim() === "REC:HELLO", `REC.NM = "REC:HELLO"（実測 "${nm.trim()}"）`);
  check(rate === "1.5000", `REC.RATE = 1.5000（実測 ${rate}）`);

  const gotItems = un64(vals[3]);
  const cells = [0, 1, 2, 3].map((i) => cp.decode(gotItems.subarray(i * 5, i * 5 + 5)).trim());
  check(cells.join(",") === "AAA,BBB,CCC,DDD", `ITEMS = AAA,BBB,CCC,DDD（実測 ${cells.join(",")}）——配列は反復**である**`);

  check(vals[4] === "4",          `CNT = 4（実測 ${vals[4]}）`);
  check(vals[5] === "9000000000", `BIG = 9000000000（実測 ${vals[5]}）——int(8) は 8 バイト`);
  check(vals[6] === "2.00",       `AMT = 1.00 + 1 = 2.00（実測 ${vals[6]}）`);

  log(`\n${pass} PASS / ${fail} FAIL`);
  process.exitCode = fail === 0 ? 0 : 1;
} finally {
  conn.close();
}
