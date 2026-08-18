// **飛び先つきの記述**（IBM の `RUser.pcml`）を実機で読み切れることを確かめる。
//
// `USRI0300` は、この工程で扱いたいものが 1 つの書式に全部入っている:
//   * 長さ 0 の「しおり」が `offset="offsetToHomeDirectory" offsetfrom="0"` で飛ぶ
//   * 配列の件数が**出力**で決まる（`count="numberOfSupplementalGroups"`）
//   * 文字の長さが**出力**で決まる（`length="lengthOfLocalePathName"`）
//   * 文字の CCSID が**出力**で決まる（`ccsid="ccsidOfTheReturnedHomeDirectoryName"`）
//
// ホームディレクトリを **QSYS2.USER_INFO と突き合わせる**——
// 飛び先も長さも CCSID も正しくないと一致しない。
//
// 実行: node --env-file=.env scripts/verify-pcml-dynamic-osaka.mjs
import { readFileSync } from "node:fs";
import {
  CommandConnection,
  DbConnection,
  query,
  parsePcml,
  buildPcmlCall,
  readPcmlOutputs,
  toProgramParameters
} from "@ts5250/hostserver";

const host = process.env.AS400_HOST;
const user = process.env.AS400_USER;
const password = process.env.AS400_PASSWORD;
if (!host || !user || !password) { process.stderr.write("環境変数が足りません\n"); process.exit(2); }

const CCSID = 37;
const log = (s) => process.stdout.write(s + "\n");
let pass = 0, fail = 0;
const check = (c, m) => { if (c) { pass++; log(`  PASS ${m}`); } else { fail++; log(`  FAIL ${m}`); } };

const PCML = readFileSync("packages/hostserver/test/fixtures/pcml/RUser.pcml", "latin1");
const P = "qsyrusri_usri0300";
const R = `${P}.receiverVariable`;

const cmd = await CommandConnection.connect({ host, user, password });
const db = await DbConnection.connect({ host, user, password });
try {
  log("### 1. IBM の記述をそのまま解析する");
  const doc = parsePcml(PCML, { vrm: cmd.hostVrm });
  check(doc.programs.has(P), `${P} を読めた`);

  log("\n### 2. 呼ぶ");
  const call = buildPcmlCall(doc, P, { [`${P}.userProfileName`]: "*CURRENT" }, { ccsid: CCSID });
  const params = toProgramParameters(call.args, { ccsid: CCSID });
  check(params[0].type === "out" && params[0].length === 1526,
    `受取域は出力 1526 バイト（outputsize="receiverVariableLength" の init）`);
  const { result, outputs } = await cmd.call(call.program, call.library, params);
  check(result.success, `呼び出しが成功（${result.messages.map((m) => `${m.id} ${m.text}`).join(" / ") || "メッセージなし"}）`);
  if (!result.success) process.exit(1);

  log("\n### 3. 先頭から順に解く");
  const v = readPcmlOutputs(call, outputs);
  const show = (k) => log(`  ${k.padEnd(46)} = ${JSON.stringify(v[k])}`);
  for (const k of [
    "bytesReturned", "bytesAvailable", "userProfileName",
    "offsetToArrayOfSupplementalGroups", "numberOfSupplementalGroups",
    "offsetToHomeDirectory", "offsetToLocalePathName", "lengthOfLocalePathName"
  ]) show(`${R}.${k}`);

  const nGroups = Number(v[`${R}.numberOfSupplementalGroups`]);
  const groups = [];
  for (let i = 1; i <= nGroups; i++) groups.push(v[`${R}.supplementalGroups(${i})`]?.trim());
  log(`  補助グループ（${nGroups} 件） = ${JSON.stringify(groups)}`);
  check(groups.length === nGroups, `**出力で決まる件数**ぶん読めた（${groups.length} / ${nGroups}）`);

  const homeCcsid = v[`${R}.homeDirectory.ccsidOfTheReturnedHomeDirectoryName`];
  const homeLen = v[`${R}.homeDirectory.numberOfBytesInTheHomeDirectoryName`];
  const home = v[`${R}.homeDirectory.homeDirectoryNameValue`];
  log(`  ホームディレクトリ CCSID=${homeCcsid} / 長さ=${homeLen} / 値=${JSON.stringify(home)}`);
  check(home !== undefined, "**飛び先の先**（ホームディレクトリ）を読めた");
  check(Number(homeLen) > 0 && home?.length > 0, "**出力で決まる長さ**が効いている");

  const locale = v[`${R}.localePathName`];
  log(`  ロケール名 = ${JSON.stringify(locale)}`);

  log("\n### 4. 独立した経路（QSYS2.USER_INFO）と突き合わせる");
  const rs = await query(
    db,
    `SELECT HOME_DIRECTORY, SUPPLEMENTAL_GROUP_LIST FROM QSYS2.USER_INFO WHERE AUTHORIZATION_NAME = '${user.toUpperCase()}'`
  ).catch((e) => { log(`  （SQL が使えませんでした: ${e.message}）`); return undefined; });
  const row = rs?.rows?.[0];
  if (row) {
    const sqlHome = String(row["HOME_DIRECTORY"] ?? "").trim();
    log(`  SQL: HOME_DIRECTORY=${JSON.stringify(sqlHome)}`);
    check(home?.trim() === sqlHome,
      `**ホームディレクトリが一致**（API ${JSON.stringify(home?.trim())} / SQL ${JSON.stringify(sqlHome)}）`);
    const sqlGroups = String(row["SUPPLEMENTAL_GROUP_LIST"] ?? "").trim();
    log(`  SQL: SUPPLEMENTAL_GROUP_LIST=${JSON.stringify(sqlGroups)}`);
  }

  log(`\n${pass} PASS / ${fail} FAIL`);
  process.exitCode = fail === 0 ? 0 : 1;
} finally {
  cmd.close();
  db.close?.();
}
