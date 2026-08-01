// `host_call_program`（プログラム呼び出し）を**正しいパラメータ列**で成功させる。
//
// backlog: 実機確認は `MCH0802`（パラメータ数不一致）までで、
// **呼び出し経路が通ることしか確かめていない**（`QGYOLSPL` にパラメータ 0 個で呼んだ）。
// 出力パラメータが要求順に返るという前提も、**成功例が無いので確かめられていない**。
//
// ここでは読み取り専用の API を 2 つ呼ぶ:
//   QUSROBJD … オブジェクト記述の取得（出力 1 つ）
//   QSYRUSRI … ユーザー情報の取得（出力 1 つ・別の書式）
// どちらも**中身を検証できる**ので、「呼べた」ではなく「正しく返った」を言える。
//
// 実行: AS400_HOST=... AS400_USER=... AS400_PASSWORD=... node --env-file=.env \
//         scripts/research-call-program.mjs
//
// 副作用なし（読み取りのみ）。
import { CommandConnection } from "@as400web/hostserver";
import { codecForCcsid } from "@as400web/ebcdic";

const host = process.env.AS400_HOST;
const user = process.env.AS400_USER;
const password = process.env.AS400_PASSWORD;
if (!host || !user || !password) {
  process.stderr.write("AS400_HOST / AS400_USER / AS400_PASSWORD を環境変数で渡してください\n");
  process.exit(2);
}

const log = (s) => process.stdout.write(s + "\n");
let pass = 0;
let fail = 0;
const check = (cond, msg) => {
  if (cond) { pass++; log(`  PASS ${msg}`); } else { fail++; log(`  FAIL ${msg}`); }
};

// **API のパラメータは EBCDIC**。ジョブの CCSID ではなく、英数字が同じ位置にある 37 で足りる
const cp = codecForCcsid(37);
/** 固定長の EBCDIC 文字列（右を空白詰め） */
const ebcdic = (s, len) => {
  const b = cp.encode(s.padEnd(len, " ")).bytes;
  return b.subarray(0, len);
};
/** 4 バイトのビッグエンディアン整数 */
const int4 = (n) => {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setInt32(0, n);
  return b;
};
/**
 * エラーコード構造（`ERRC0100`）。
 * **先頭 4 バイト（bytes provided）を 0 にすると「例外で知らせる」**——
 * こちらは戻りメッセージで受けたいので 0 のままにする（原典の作法）。
 */
const errorCode = () => int4(0);
/** 修飾オブジェクト名（名前 10 ＋ ライブラリ 10 の 20 バイト） */
const qualified = (name, lib) => new Uint8Array([...ebcdic(name, 10), ...ebcdic(lib, 10)]);
const readEbcdic = (b, at, len) => cp.decode(b.subarray(at, at + len)).trimEnd();

const conn = await CommandConnection.connect({ host, user, password });
try {
  // ---- 1. QUSROBJD: QSYS/QCMD (*PGM) の記述を取る ----
  log("### QUSROBJD（オブジェクト記述）");
  {
    const RECV = 200;
    const { result, outputs } = await conn.call("QUSROBJD", "QSYS", [
      { type: "out", length: RECV },              // 1 受け取り変数
      { type: "in", data: int4(RECV) },           // 2 受け取り変数の長さ
      { type: "in", data: ebcdic("OBJD0100", 8) },// 3 書式名
      { type: "in", data: qualified("QCMD", "QSYS") }, // 4 修飾オブジェクト名（名前 10 ＋ ライブラリ 10）
      { type: "in", data: ebcdic("*PGM", 10) },   // 5 オブジェクト種別
      { type: "in", data: errorCode() }           // 6 エラーコード
    ]);
    log(`  rc=0x${result.returnCode.toString(16)} success=${result.success}` +
        (result.messages?.length ? ` msgs=${result.messages.map((m) => m.id).join(",")}` : ""));
    check(result.messages.length === 0, "メッセージが出ない（MCH0802 のような不一致が無い）");

    const recv = outputs[0];
    check(Boolean(recv), "出力パラメータが 1 番目に返る（要求順の前提）");
    if (recv) {
      const view = new DataView(recv.buffer, recv.byteOffset, recv.byteLength);
      const bytesReturned = view.getInt32(0);
      const bytesAvailable = view.getInt32(4);
      const objName = readEbcdic(recv, 8, 10);
      const objLib = readEbcdic(recv, 18, 10);
      const objType = readEbcdic(recv, 28, 10);
      log(`  bytesReturned=${bytesReturned} bytesAvailable=${bytesAvailable}`);
      log(`  object=${objName} library=${objLib} type=${objType}`);
      check(bytesReturned > 0, `受け取り変数に中身がある（${bytesReturned} バイト）`);
      check(objName === "QCMD", `オブジェクト名が QCMD（実際: ${objName}）`);
      check(objLib === "QSYS", `ライブラリが QSYS（実際: ${objLib}）`);
      check(objType === "*PGM", `種別が *PGM（実際: ${objType}）`);
    }
  }

  // ---- 2. QSYRUSRI: 自分のユーザー情報を取る（別の書式で位置合わせを確かめる）----
  log("\n### QSYRUSRI（ユーザー情報）");
  {
    const RECV = 400;
    const { result, outputs } = await conn.call("QSYRUSRI", "QSYS", [
      { type: "out", length: RECV },               // 1 受け取り変数
      { type: "in", data: int4(RECV) },            // 2 長さ
      { type: "in", data: ebcdic("USRI0100", 8) }, // 3 書式名
      { type: "in", data: ebcdic(user, 10) },      // 4 ユーザープロファイル名
      { type: "in", data: errorCode() }            // 5 エラーコード
    ]);
    log(`  rc=0x${result.returnCode.toString(16)}` +
        (result.messages?.length ? ` msgs=${result.messages.map((m) => m.id).join(",")}` : ""));
    check(result.messages.length === 0, "メッセージが出ない");
    const recv = outputs[0];
    if (recv) {
      const name = readEbcdic(recv, 8, 10);
      log(`  user=${name}`);
      check(name === user.toUpperCase(), `ユーザー名が ${user.toUpperCase()}（実際: ${name}）`);
    } else {
      check(false, "出力パラメータが返る");
    }
  }

  // ---- 3. 出力でないパラメータの位置は null で返るか ----
  log("\n### 出力の位置合わせ");
  {
    const { outputs } = await conn.call("QUSROBJD", "QSYS", [
      { type: "out", length: 100 },
      { type: "in", data: int4(100) },
      { type: "in", data: ebcdic("OBJD0100", 8) },
      { type: "in", data: qualified("QCMD", "QSYS") },
      { type: "in", data: ebcdic("*PGM", 10) },
      { type: "in", data: errorCode() }
    ]);
    log(`  outputs = [${outputs.map((o) => (o ? `<${o.length}B>` : "null")).join(", ")}]`);
    check(outputs.length === 6, `要求したパラメータ数だけ返る（実際: ${outputs.length}）`);
    check(Boolean(outputs[0]), "出力パラメータの位置に中身がある");
    check(outputs.slice(1).every((o) => !o), "入力パラメータの位置は null");
  }
} finally {
  conn.close();
}

log(`\n${fail === 0 ? "OK" : "NG"} — ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
