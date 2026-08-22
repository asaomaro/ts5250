// **IBM i 7.3 と 7.5 で挙動が違う箇所を洗う**（`.aidev/backlog/hostserver.md`）。
//
// 問い:
//   「2 リリースで動いた」ことと「差分を把握している」ことは別。**片側でしか測っていない
//   項目**（DDM / DTAQ / スプール / MSGW など）は、片側だけの確認になっている。
//
// SR-OSAKA は **7.3**、pub400 は **7.5**。**同じことを両方で測って並べる**。
//
// 実行:
//   node --env-file=.env scripts/compare-hosts-osaka-pub400.mjs           # 両方
//   node --env-file=.env scripts/compare-hosts-osaka-pub400.mjs AS400     # 片方だけ
//
// ⚠ **pub400 は公開の共有機**。作るものは `QTEMP` と `/tmp` に閉じ、後始末する。
// ⚠ **サインオンの失敗は QMAXSIGN に数えられる**（SR-OSAKA=3 / pub400=5）。
import {
  CommandConnection,
  DbConnection,
  DtaqConnection,
  IfsConnection,
  query,
  executeStatement,
  listSpooledFiles
} from "@ts5250/hostserver";

const TARGETS = process.argv.slice(2).length > 0 ? process.argv.slice(2) : ["AS400", "PUB400"];
const out = (s) => process.stdout.write(s + "\n");

/** 1 項目の結果。**差分を並べるのが目的**なので、値を短い文字列に畳む */
const results = {};
const note = (host, key, value) => {
  (results[key] ??= {})[host] = String(value).replace(/\s+/gu, " ").slice(0, 90);
};

async function probe(pre) {
  const host = process.env[`${pre}_HOST`];
  const user = process.env[`${pre}_USER`];
  const password = process.env[`${pre}_PASSWORD`];
  if (!host || !user || !password) {
    out(`（${pre}_HOST / _USER / _PASSWORD が無いので飛ばす）`);
    return;
  }
  out(`\n########## ${pre} ##########`);
  const cred = { host, user, password };

  // ---- 版数・システム値 ----
  const db = await DbConnection.connect(cred);
  const rows = (r) => r.rows.map((x) => Object.values(x).map((v) => String(v ?? "").trim()));
  /** **1 つ失敗しても他を続ける。** 差分を洗うのが目的なので、途中で止まると意味が無い */
  const step = async (key, fn) => {
    try { note(pre, key, await fn()); }
    catch (e) { note(pre, key, `失敗: ${String(e.message).slice(0, 60)}`); }
  };
  try {
    // **版数は `SYSIBMADM.ENV_SYS_INFO`**（`QSYS2.SYSTEM_STATUS_INFO` にこの欄は無い。
    // `SQLCODE=-206` で 2 度踏んだ）
    await step("版数", async () => {
      const v = await query(db, `SELECT OS_NAME, OS_VERSION, OS_RELEASE FROM SYSIBMADM.ENV_SYS_INFO`);
      const r = rows(v)[0] ?? [];
      return `${r[0] ?? "?"} V${r[1] ?? "?"}R${r[2] ?? "?"}`;
    });
    await step("累積 PTF", async () => {
      // 列名は `PTF_GROUP_NAME`（`PTF_GROUP_ID` ではない。`SQLCODE=-206` で踏んだ）
      const g = await query(db, `SELECT PTF_GROUP_NAME, PTF_GROUP_LEVEL FROM QSYS2.GROUP_PTF_INFO
        WHERE PTF_GROUP_NAME LIKE 'SF99%' ORDER BY PTF_GROUP_NAME FETCH FIRST 1 ROW ONLY`);
      return rows(g)[0]?.join(" レベル ") ?? "取れず";
    });
    try {
      const sv = await query(db, `SELECT SYSTEM_VALUE_NAME, COALESCE(CURRENT_CHARACTER_VALUE, CHAR(CURRENT_NUMERIC_VALUE)) AS V
        FROM QSYS2.SYSTEM_VALUE_INFO WHERE SYSTEM_VALUE_NAME IN ('QCCSID','QPWDLVL','QCHRID','QLANGID','QAUTOVRT','QMAXSIGN')`);
      for (const [n, val] of rows(sv)) note(pre, `システム値 ${n}`, val);
    } catch (e) { note(pre, "システム値", `失敗: ${String(e.message).slice(0, 60)}`); }

    await step("SQL SELECT", async () => {
      const q = await query(db, `SELECT COUNT(*) AS N FROM QSYS2.SYSTABLES WHERE TABLE_SCHEMA='QSYS2'`);
      return `QSYS2 の表 ${rows(q)[0]?.[0]} 件`;
    });

    await step("SQL 非クエリ", async () => {
      await executeStatement(db, `CREATE TABLE QTEMP.CMPT (K INT, V CHAR(10))`);
      const ins = await executeStatement(db, `INSERT INTO QTEMP.CMPT VALUES (1,'a'),(2,'b')`);
      return `CREATE/INSERT ok（影響 ${ins?.updateCount ?? "?"} 行）`;
    });
    await step("SQL 往復", async () => {
      const sel = await query(db, `SELECT V FROM QTEMP.CMPT ORDER BY K`);
      return rows(sel).map((r) => r[0]).join(",");
    });

    // **SELECT を非クエリ経路へ流したときの落ち方**（黙って壊れないことの確認）
    await step("SELECT を非クエリ経路へ", async () => {
      try {
        await executeStatement(db, `SELECT 1 FROM SYSIBM.SYSDUMMY1`);
        return "**通ってしまった**";
      } catch (e) {
        return `${e.sqlCode ?? "?"} / ${e.sqlState ?? "?"}`;
      }
    });

    await step("CREATE の SQLCODE", async () => {
      const r = await executeStatement(db, `CREATE TABLE QTEMP.CMPW (K INT)`);
      return String(r?.sqlCode ?? 0);
    });

    // **取得量**（同じ行数を取ったときの往復とバイト数。7.3 と 7.5 で変わるか）
    await step("20 行取得", async () => {
      const t0 = Date.now();
      const q = await query(db, `SELECT TABLE_NAME FROM QSYS2.SYSTABLES WHERE TABLE_SCHEMA='QSYS2'
        ORDER BY TABLE_NAME FETCH FIRST 20 ROWS ONLY`);
      return `${q.rows.length} 行 / ${Date.now() - t0}ms`;
    });
  } finally {
    await db.close();
  }

  // ---- コマンドサーバー ----
  try {
    const cmd = await CommandConnection.connect(cred);
    try {
      const r = await cmd.run("CHGLIBL LIBL(QGPL QTEMP)");
      note(pre, "コマンド実行", `rc=${r.returnCode} msg=${(r.messages ?? []).map((m) => m.id).join(",") || "なし"}`);
    } catch (e) {
      note(pre, "コマンド実行", `失敗: ${e.message.slice(0, 60)}`);
    }
    try {
      // **プログラム呼び出し**（QCDRCMDD でコマンド定義を引く。読むだけ）
      const { retrieveCommandTemplate } = await import("@ts5250/hostserver");
      // ⚠ **CRTLIB は使わない。** pub400 では QSYS/CRTLIB が見えず（公開機なので
      // ライブラリ作成を禁じている）、`QCDRCMDD returned no data` になる。
      // **版数の差ではなく権限の差**。どこでも引ける `SNDMSG` で測る
      const t = await retrieveCommandTemplate(cmd, "SNDMSG");
      note(pre, "コマンド定義の取得", `SNDMSG ${t.parameters.length} パラメータ / XML ${t.xml.length}B`);
    } catch (e) {
      note(pre, "プログラム呼び出し", `失敗: ${e.message.slice(0, 60)}`);
    }
    await cmd.close();
  } catch (e) {
    note(pre, "コマンドサーバー", `接続できず: ${e.message.slice(0, 60)}`);
  }

  // ---- IFS ----
  try {
    const ifs = await IfsConnection.connect(cred);
    const path = `/tmp/cmp-${pre.toLowerCase()}.txt`;
    await ifs.writeFile(path, new TextEncoder().encode("hello\n"), { create: true, dataCcsid: 1208 });
    const got = await ifs.readTextFile(path);
    note(pre, "IFS 書き読み", `ccsid=${got?.ccsid ?? "?"} 長さ=${(got?.data ?? got)?.length ?? "?"}`);
    ifs.close?.();
  } catch (e) {
    note(pre, "IFS 書き読み", `失敗: ${e.message.slice(0, 60)}`);
  }

  // ---- スプール一覧・データ待ち行列（**同じコマンド接続**を使う）----
  try {
    const cmd = await CommandConnection.connect(cred);
    // `listSpooledFiles` は**接続を受ける**（資格情報ではない）
    try {
      const spools = await listSpooledFiles(cmd, { user: "*CURRENT" }, { max: 20 });
      note(pre, "スプール一覧", `${spools.length} 件`);
    } catch (e) {
      note(pre, "スプール一覧", `失敗: ${String(e.message).slice(0, 60)}`);
    }
    // **データ待ち行列は QGPL に作って消す**（QTEMP は接続ごとなので別接続から読めない）
    const DQ = "CMPDQ";
    try {
      await cmd.run(`DLTDTAQ DTAQ(QGPL/${DQ})`).catch(() => undefined);
      await cmd.run(`CRTDTAQ DTAQ(QGPL/${DQ}) MAXLEN(64)`);
      // **長さは PACKED(5,0)**（`X'00000005'` のような 2 進で渡すと
      // `CPF24B4 Severe error while addressing parameter list.`）
      await cmd.run(`CALL QSYS/QSNDDTAQ PARM('${DQ}     ' 'QGPL      ' X'00005F' 'hello')`);
      const dq = await DtaqConnection.connect(cred);
      const e = await dq.read({ library: "QGPL", name: DQ, wait: 0 });
      note(pre, "DTAQ 読み取り", e ? `取れた（${e.data?.length ?? "?"}B）` : "**空**");
      dq.close?.();
    } catch (e) {
      note(pre, "DTAQ 読み取り", `失敗: ${String(e.message).slice(0, 60)}`);
    } finally {
      await cmd.run(`DLTDTAQ DTAQ(QGPL/${DQ})`).catch(() => undefined);
    }
    await cmd.close();
  } catch (e) {
    note(pre, "スプール／DTAQ", `接続できず: ${String(e.message).slice(0, 60)}`);
  }
}

for (const t of TARGETS) {
  try {
    await probe(t);
  } catch (e) {
    out(`（${t} で例外: ${String(e.message).slice(0, 120)}）`);
  }
}

out("\n\n================ 差分 ================");
const hosts = TARGETS;
const w = Math.max(...Object.keys(results).map((k) => k.length)) + 2;
for (const [key, byHost] of Object.entries(results)) {
  const vals = hosts.map((h) => byHost[h] ?? "—");
  const same = vals.every((v) => v === vals[0]);
  out(`${same ? "  " : "**"}${key.padEnd(w)} ${vals.map((v, i) => `${hosts[i]}: ${v}`).join("   |   ")}`);
}
out("\n（**印は両機で違ったもの）");
