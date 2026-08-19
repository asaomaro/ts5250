// **CL コマンドのテンプレート**（`QCDRCMDD`）の実機検証。
//
// テンプレートを引き、引用の要る値を埋めてコマンドを組み、実機で通し、**読み戻して一致を見る**。
// 引用の作法は机上では確かめられない——`TEXT('It''s …')` が本当に打った通りに入るかは、
// ホストに作らせて読み戻すしかない。
//
// 実行: node --env-file=.env scripts/verify-command-template.mjs
// 必要な環境変数: AS400_HOST / AS400_USER / AS400_PASSWORD
import { CommandConnection, retrieveCommandTemplate, buildCommand, runCommandTemplate, CommandTemplateCache, DbConnection, queryLimited } from "@ts5250/hostserver";
const host = process.env.AS400_HOST, user = process.env.AS400_USER, password = process.env.AS400_PASSWORD;
const LIB = "TPLTEST";
const conn = await CommandConnection.connect({ host, user, password });
const cache = new CommandTemplateCache();
const log = (s) => process.stderr.write(s + "\n");
const ok = (s) => log("  PASS " + s);
const ng = (s) => { log("  FAIL " + s); process.exitCode = 1; };
try {
  // 後片付け（前回の残り）
  await conn.run(`DLTLIB LIB(${LIB})`).catch(() => {});

  const tpl = await retrieveCommandTemplate(conn, "CRTLIB");
  log(`テンプレート: ${tpl.name} (${tpl.library}) パラメータ ${tpl.parameters.length} 個`);
  log("  " + tpl.parameters.map((p) => `${p.keyword}${p.required ? "*" : ""}`).join(" "));

  // **引用が要る値**を渡す（空白・小文字・引用符）
  const TEXT = "It's a テスト lib";
  const cmd = buildCommand(tpl, { LIB, TEXT, TYPE: "*TEST" });
  log("組んだコマンド:", cmd);
  const r = await conn.runOrThrow(cmd);
  ok("実機で通った（" + (r.messages?.length ?? 0) + " メッセージ）");

  // 読み戻して一致を見る
  const db = await DbConnection.connect({ host, user, password });
  const q = await queryLimited(db,
    `SELECT OBJTEXT FROM TABLE(QSYS2.OBJECT_STATISTICS('QSYS','*LIB','${LIB}')) X`, { limit: 5 });
  const back = String(Object.values(q.rows[0] ?? {})[0] ?? "");
  log("読み戻した TEXT:", JSON.stringify(back));
  if (back.trim() === TEXT) ok("引用が正しい（打った通りに入った）");
  else ng(`一致しない: ${JSON.stringify(back.trim())}`);
  await db.close?.();

  // runCommandTemplate の一発呼び出し（キャッシュも効かせる）
  const r2 = await runCommandTemplate(conn, "CHGOBJD", { OBJ: `QSYS/${LIB}`, OBJTYPE: "*LIB", TEXT: "changed by template" }, { cache });
  ok("runCommandTemplate: " + r2.command);

  // 打つ前に弾けること（実機に行かせない）
  try { buildCommand(tpl, { LIB: "X", TYPE: "*BOGUS" }); ng("許されない値が通ってしまった"); }
  catch (e) { ok("許されない値を打つ前に弾いた: " + e.message.slice(0, 50)); }
} finally {
  await conn.run(`DLTLIB LIB(${LIB})`).catch(() => {});
  await conn.close?.();
}
