// **IBM が配っている記述のまま、実機の API を呼べることを確かめる。**
//
// 使うのは `jtopen` 同梱の `qsyrusri.pcml`（Retrieve User Information）。
// **1 文字も手を入れていない**——整えると「IBM が配る形」を通したことにならない。
//
// この記述には、こちらが今まで扱えなかったものが入っている:
//   * 名前の無い `<data>`（予約域。触れないが場所は取る）
//   * 小文字の `path="/QSYS.lib/QSYRUSRI.pgm"`
//   * 入力の `init`（呼ぶ側は受取域の長さだけ入れればよい）
//
// 返った値は**独立した経路**（QSYS2.USER_INFO）と突き合わせる——
// 「呼べた」ではなく「正しく返った」を言うため。
//
// 実行: node --env-file=.env scripts/verify-pcml-api.mjs
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

const PCML = readFileSync("packages/hostserver/test/fixtures/pcml/qsyrusri.pcml", "latin1");

const cmd = await CommandConnection.connect({ host, user, password });
const db = await DbConnection.connect({ host, user, password });
try {
  log("### 1. ホストの版");
  const v = cmd.hostVrm;
  log(`  V${(v >>> 16) & 0xffff}R${(v >>> 8) & 0xff}M${v & 0xff}（生値 ${v}）`);
  check(v > 0, "signon から版を取れた（minvrm の判定に要る）");

  log("\n### 2. IBM の記述をそのまま解析する");
  const doc = parsePcml(PCML, { vrm: v });
  const pgm = doc.programs.get("qsyrusri");
  check(Boolean(pgm), "qsyrusri を読めた");
  const rec = pgm.fields[0];
  check(rec.fields.length === 16, `受取域は 16 項目（実測 ${rec.fields.length}）`);
  const reserved = rec.fields.filter((f) => f.name === "");
  check(reserved.length === 2, `うち**名前なしの予約域が 2 つ**（実測 ${reserved.length}）`);

  log("\n### 3. 名前で呼ぶ");
  // 受取域は 4+4+10+7+6+1+4+10+8+1+1+4+8+4+1+10 = 83 バイト
  const call = buildPcmlCall(doc, "qsyrusri", { "qsyrusri.receiverLength": "83" }, { ccsid: CCSID });
  check(call.library === "QSYS" && call.program === "QSYRUSRI",
    `呼び先 ${call.library}/${call.program}（小文字の path から解いた）`);
  const params = toProgramParameters(call.args, { ccsid: CCSID });
  check(params.length === 5, `引数は 5 本（実測 ${params.length}）`);
  check(params[0].type === "out" && params[0].length === 83,
    `受取域は出力 83 バイト（実測 ${params[0].type} ${params[0].length ?? "-"}）`);

  const { result, outputs } = await cmd.call(call.program, call.library, params);
  check(result.success, `呼び出しが成功（${result.messages.map((m) => `${m.id} ${m.text}`).join(" / ") || "メッセージなし"}）`);
  if (!result.success) process.exit(1);

  const got = readPcmlOutputs(call, outputs);
  log("\n### 4. 返った値");
  for (const k of ["bytesReturned", "bytesAvailable", "userProfile", "status", "badSignonAttempts"]) {
    log(`  qsyrusri.receiver.${k.padEnd(20)} = ${JSON.stringify(got[`qsyrusri.receiver.${k}`])}`);
  }

  check(got["qsyrusri.receiver.bytesReturned"] === "83", `bytesReturned = 83（実測 ${got["qsyrusri.receiver.bytesReturned"]}）`);
  check(Number(got["qsyrusri.receiver.bytesAvailable"]) >= 83, "bytesAvailable が受取域以上（切れていない）");
  const profile = got["qsyrusri.receiver.userProfile"]?.trim();
  check(profile === user.toUpperCase(), `userProfile = ${user.toUpperCase()}（実測 ${profile}）`);

  log("\n### 5. 独立した経路（QSYS2.USER_INFO）と突き合わせる");
  const rs = await query(
    db,
    `SELECT STATUS, SIGN_ON_ATTEMPTS_NOT_VALID FROM QSYS2.USER_INFO WHERE AUTHORIZATION_NAME = '${user.toUpperCase()}'`
  ).catch((e) => { log(`  （SQL が使えませんでした: ${e.message}）`); return undefined; });
  const row = rs?.rows?.[0];
  if (row) {
    // 行は**列名の連想配列**（`Row = Record<string, DbValue>`）
    const status = String(row["STATUS"] ?? "").trim();
    const attempts = String(row["SIGN_ON_ATTEMPTS_NOT_VALID"] ?? "").trim();
    log(`  SQL: STATUS=${status} / SIGN_ON_ATTEMPTS_NOT_VALID=${attempts}`);
    check(got["qsyrusri.receiver.status"]?.trim() === status,
      `status が一致（API ${got["qsyrusri.receiver.status"]?.trim()} / SQL ${status}）`);
    check(String(Number(got["qsyrusri.receiver.badSignonAttempts"])) === String(Number(attempts)),
      `badSignonAttempts が一致（API ${got["qsyrusri.receiver.badSignonAttempts"]} / SQL ${attempts}）`);
  } else {
    log("  （QSYS2.USER_INFO を読めなかったので突き合わせは飛ばす）");
  }

  log(`\n${pass} PASS / ${fail} FAIL`);
  process.exitCode = fail === 0 ? 0 : 1;
} finally {
  cmd.close();
  db.close?.();
}
