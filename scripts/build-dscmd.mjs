// **READ IMMEDIATE(0x72) を実機から発行させる**ための試験プログラムを作る。
//
// 問い（`.aidev/backlog/datastream-commands.md`）:
//   `0x72` は 20 画面 142 レコードの census でも届かない。実装は原典から書き起こしたが、
//   **実機の裏取りができていない**。→ **こちらから発行させればよい。**
//
// IBM i は**自分で 0x72 を発行する API を出荷している**。`QSYSINC/H(QSNAPI)`（動的画面管理）:
//
//     #define QSN_READ_IMM   0x72
//     Q_Bin4 QsnReadImm(Q_Bin4 *, Qsn_Inp_Buf_T, Qsn_Cmd_Buf_T, Qsn_Env_T, Q_Fdbk_T *);
//
// **IBM 自身の一次資料で opcode が 0x72 と確定する**（tn5250 / tn5250j に続く 3 つ目の出典）。
//
// この script は C ソースを IFS に置いて `CRTBNDC ... SRCSTMF(...)` でコンパイルするだけ。
// **走らせるのは `diag-read-immediate.mjs`**（5250 セッションから CALL してトレースを見る）。
//
// 実行: node --env-file=.env --env-file=.env.verify scripts/build-dscmd.mjs
import { readFileSync } from "node:fs";
import { CommandConnection, IfsConnection } from "@ts5250/hostserver";

const host = process.env.AS400_HOST;
const user = process.env.AS400_USER;
const password = process.env.AS400_PASSWORD;
if (!host || !user || !password) { process.stderr.write("AS400_* が要ります\n"); process.exit(2); }

const LIB = process.env.DSCMD_LIB ?? "TESTLIB";
const PGM = process.env.DSCMD_PGM ?? "DSCMD";
const STMF = process.env.DSCMD_SRC ?? `/tmp/${PGM.toLowerCase()}.c`;
const LOGF = process.env.DSCMD_LOG ?? `/tmp/${PGM.toLowerCase()}.log`;
const out = (s) => process.stdout.write(s + "\n");

/**
 * **画面へ何も書かずに READ IMMEDIATE だけを出す。**
 *
 * 欄が無ければ応答は「行・桁・AID(0)」の 3 バイトになるはずで、**それでも往復が成立するか**が
 * 見たいこと。`printf` は DSM と混ぜない方がよいので、結果は**データ域**へ書いて後から読む。
 */
// **ソースは `scripts/host-src/dscmd.c`**（テンプレート文字列に埋めるとエスケープ事故が起きる。
// 実際に一度踏んだ——`\n` が二重になって型の直しが効かなかった）
const SOURCE = readFileSync(new URL("./host-src/dscmd.c", import.meta.url), "utf8")
  .replace("DSCMD_LOG", JSON.stringify(LOGF));


const cmd = await CommandConnection.connect({ host, user, password });
const run = async (c, { allowFail = false } = {}) => {
  try {
    const r = await cmd.run(c);
    // **メッセージを先に出す。** 投げてから出すと、失敗の中身が見えないまま落ちる（実際に踏んだ）
    const early = (r.messages ?? []).map((m) => `${m.id ?? ""} ${m.text ?? ""}`.trim()).filter(Boolean);
    if (r.success === false) {
      for (const m of early.slice(0, 8)) out(`       · ${m.replace(/\s+/g, " ").slice(0, 160)}`);
      throw new Error(`rc=${r.returnCode}`);
    }
    // **メッセージも出す。** 「OK」だけ見て進むと、実際は作られていないのに気づけない
    // （CRTBNDC が黙って何も作らなかった実績あり）
    const msgs = (r.messages ?? []).map((m) => `${m.id ?? ""} ${m.text ?? ""}`.trim()).filter(Boolean);
    out(`  OK   ${c}`);
    for (const m of msgs.slice(0, 6)) out(`       · ${m.replace(/\s+/g, " ").slice(0, 160)}`);
    return r;
  } catch (e) {
    out(`  ${allowFail ? "--  " : "NG  "} ${c}`);
    out(`       ${String(e.message).replace(/\s+/g, " ").slice(0, 200)}`);
    if (!allowFail) throw e;
    return undefined;
  }
};

out(`# ソースを IFS へ置く（${STMF}）`);
const ifs = await IfsConnection.connect({ host, user, password });
await ifs.writeFile(STMF, new TextEncoder().encode(SOURCE), { create: true, dataCcsid: 1208 });
ifs.close?.();
out("  OK");

out(`\n# コンパイル（${LIB}/${PGM}）`);
await run(`DLTPGM PGM(${LIB}/${PGM})`, { allowFail: true });
// **TGTCCSID(*JOB) を指定する**——IFS のソースは UTF-8(1208) で置いたので、既定のままだと化ける
// **SYSIFCOPT(*IFSIO)**——fopen を IFS のストリーム・ファイルへ向ける（既定はレコード・ファイル）
await run(`CRTBNDC PGM(${LIB}/${PGM}) SRCSTMF('${STMF}') TGTCCSID(*JOB) SYSIFCOPT(*IFSIO) TEXT('5250 コマンドを実機から発行させる')`);
// ⚠ **CRTBNDC は失敗しても戻りコード 0 で返ることがある**（実測。CZM1613 が診断メッセージ止まり）。
// 「OK」を信じず、**物が在るかを確かめる**
// ⚠ **CRTBNDC は失敗しても戻りコード 0 で返る**（実測。CZM1613 は診断メッセージ止まり）。
// 「OK」を信じず**物が在るかを確かめる**
const check = await cmd.run(`CHKOBJ OBJ(${LIB}/${PGM}) OBJTYPE(*PGM)`).catch(() => undefined);
if (check === undefined || check.success === false) {
  out(`\n**${LIB}/${PGM} は作られていない。** 上のメッセージを見ること`);
  process.exitCode = 1;
} else {
  out(`\n完了（${LIB}/${PGM} を確認）。走らせるのは scripts/diag-read-immediate.mjs`);
}
await cmd.close();
