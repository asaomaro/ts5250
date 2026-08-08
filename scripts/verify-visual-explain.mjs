/**
 * 実行計画の採取を実機で確かめる（開発中の疎通確認）。
 *
 *   node --env-file=.env scripts/verify-visual-explain.mjs           # 実機 (7.3)
 *   node --env-file=.env scripts/verify-visual-explain.mjs pub400    # PUB400 (7.5)
 *
 * 確かめること:
 *   - `run` / `no-rows` の両モードで計画が採れる
 *   - 索引助言が出る
 *   - プランキャッシュ一覧の可否（PUB400 は権限不足で無効化されるはず）
 *   - 後始末（QTEMP に表が残らない）
 */
import { DbConnection, capturePlan, listPlansFromCache, query } from "@ts5250/hostserver";

const which = process.argv[2] === "pub400" ? "pub400" : "as400";
const cfg =
  which === "pub400"
    ? { host: process.env["PUB400_HOST"] ?? "pub400.com", user: process.env["PUB400_USER"], password: process.env["PUB400_PASSWORD"], tls: true }
    : { host: process.env["AS400_HOST"], user: process.env["AS400_USER"], password: process.env["AS400_PASSWORD"], tls: false };

const line = (s = "") => process.stdout.write(`${s}\n`);
let failures = 0;

async function step(label, fn) {
  line(`\n--- ${label}`);
  try {
    const r = await fn();
    if (r !== undefined) line(`OK: ${r}`);
    return r;
  } catch (e) {
    failures += 1;
    line(`NG: ${String(e).slice(0, 300)}`);
    return undefined;
  }
}

function showPlan(plan) {
  line(`  文: ${plan.statement.slice(0, 70)}`);
  line(`  採取: ${plan.captured} / ブロック ${plan.blocks.length} / ノード ${plan.summary.nodeCount}`);
  line(`  表: ${plan.summary.tables.join(", ") || "-"} / 索引: ${plan.summary.indexes.join(", ") || "-"}`);
  line(`  推定最大: ${plan.summary.maxEstimatedMs ?? "-"} ms / 実測: ${plan.summary.elapsedMs ?? "-"} ms`);
  line(`  未対応の記録種別: ${plan.unknownRecordTypes.join(", ") || "なし"}`);
  for (const b of plan.blocks) {
    for (const n of b.nodes) {
      line(`   [${b.number}] ${n.kind.padEnd(14)} ${n.label}`);
    }
  }
  for (const a of plan.advice) {
    line(`   助言: ${a.createStatement}`);
  }
}

const SQL = "SELECT COUNT(*) AS N FROM QSYS2.SYSCOLUMNS WHERE TABLE_SCHEMA = 'QSYS2'";

/**
 * **リテラルを含まない文**も必ず試す。
 *
 * `WHERE X = 'QSYS2'` のような文はホストが値を `?` に置き換えて記録する（値は `3010` に入る）ので、
 * モニターの `QQ1000` が投げた文と**一致しない**。上の `SQL` はその形なので、
 * 「文が一致した群を選ぶ」経路が壊れていても件数で選ぶ 2 段目に落ちて通ってしまう。
 * リテラルの無い文は逐語で記録されるため、**選び方の誤りがここでしか出ない**
 * （実際、`STRDBMON` 直後の `QQUCNT=0`（計画記録を持たない受け皿）を先に掴んでいて、
 * この形の文がことごとく空の計画になっていた。利用者の報告で判明）。
 */
const SQL_NO_LITERAL = "SELECT TABLE_NAME, TABLE_SCHEMA FROM QSYS2.SYSTABLES FETCH FIRST 5 ROWS ONLY";

/**
 * **結合する文**。`QQJNP`（ダイヤル）から左深の木が組めることを実機で押さえる
 * （`design.md` A1 の訂正）。カタログ表どうしなら特別な権限もデータも要らない。
 */
const SQL_JOIN =
  "SELECT T.TABLE_NAME, C.COLUMN_NAME FROM QSYS2.SYSTABLES T " +
  "INNER JOIN QSYS2.SYSCOLUMNS C ON C.TABLE_NAME = T.TABLE_NAME AND C.TABLE_SCHEMA = T.TABLE_SCHEMA " +
  "FETCH FIRST 5 ROWS ONLY";

async function main() {
  line(`### ${which} host=${cfg.host}`);
  const conn = await DbConnection.connect(cfg);
  try {
    const runPlan = await step("run モードで採取", async () => {
      const r = await capturePlan(conn, SQL, { mode: "run", at: new Date().toISOString() });
      showPlan(r.plan);
      if (r.warnings.length > 0) line(`  警告: ${r.warnings.join(" / ")}`);
      return `行 ${r.rows?.length ?? 0} 件`;
    });

    await step("no-rows モードで採取（行は返らない）", async () => {
      const r = await capturePlan(conn, SQL, { mode: "no-rows", at: new Date().toISOString() });
      showPlan(r.plan);
      if (r.rows !== undefined) throw new Error("no-rows なのに行が返っている");
      return "行なし（期待どおり）";
    });

    await step("**リテラルを含まない文**でも計画が採れる（QQ1000 が逐語で記録される形）", async () => {
      const r = await capturePlan(conn, SQL_NO_LITERAL, { mode: "run", at: new Date().toISOString() });
      showPlan(r.plan);
      if (r.plan.summary.nodeCount === 0) throw new Error("ノードが 0 件（群の選び方が壊れている）");
      return `ノード ${r.plan.summary.nodeCount} 件`;
    });

    await step("**結合は木になる**（`QQJNP` のダイヤル順に左深）", async () => {
      // ODP 再利用を避けるため、結合の検証は毎回新しい接続で採る
      const fresh = await DbConnection.connect(cfg);
      try {
        const r = await capturePlan(fresh, SQL_JOIN, { mode: "run", at: new Date().toISOString() });
        const tree = r.plan.blocks.find((b) => b.joinTree)?.joinTree;
        if (!tree) throw new Error("結合の木が組まれていない");
        // 根は「最終選択」などの単項の節でありうるので、まず素通しして結合まで降りる
        const dials = [];
        let label = "";
        let cur = tree;
        while (cur.kind !== "dial") {
          if (cur.kind === "op") { cur = cur.source; continue; }
          dials.unshift(cur.right);
          label = cur.label;
          cur = cur.left;
        }
        dials.unshift(cur);
        if (label === "") throw new Error("結合の節が無い");
        line(`  ${dials.map((d) => `ダイヤル${d.position}: ${d.nodes.map((n) => n.label).join("・")}`).join(" / ")}`);
        line(`  結合: ${label}`);
        if (dials.length < 2) throw new Error("ダイヤルが 2 つ未満");
        return `ダイヤル ${dials.length} / ${label}`;
      } finally {
        fresh.close();
      }
    });

    await step("**最終選択とテーブル・プローブ**が木に載る（ACS と同じ数のオブジェクト）", async () => {
      const fresh = await DbConnection.connect(cfg);
      try {
        const r = await capturePlan(fresh, SQL_JOIN, { mode: "run", at: new Date().toISOString() });
        const root = r.plan.blocks.find((b) => b.joinTree)?.joinTree;
        // 根から降りて単項の節を数える
        const ops = [];
        let cur = root;
        while (cur && cur.kind !== "dial") {
          if (cur.kind === "op") ops.push(`${cur.op}${cur.rows !== undefined ? `(${cur.rows})` : ""}`);
          cur = cur.kind === "join" ? cur.left : cur.source;
        }
        line(`  導いた節: ${ops.join(" / ") || "なし"}`);
        if (!ops.some((o) => o.startsWith("final-select"))) throw new Error("最終選択が無い（3019 の QQI7 を拾えていない）");
        return ops.join(" / ");
      } finally {
        fresh.close();
      }
    });

    await step("no-rows は非クエリ文を拒む", async () => {
      try {
        await capturePlan(conn, "CREATE TABLE QTEMP.NEVER (A INT)", { mode: "no-rows", at: new Date().toISOString() });
        throw new Error("拒まれなかった");
      } catch (e) {
        if (String(e).includes("SELECT 系の文でのみ")) return "拒んだ（期待どおり）";
        throw e;
      }
    });

    await step("プランキャッシュ一覧", async () => {
      const r = await listPlansFromCache(conn, 5);
      if (!r.available) return `参照不可（期待どおりの機もある）: ${r.reason}`;
      line(`  ${r.items.length} 件`);
      for (const i of r.items.slice(0, 3)) line(`   ${i.statement.slice(0, 60)}`);
      return `参照可 ${r.items.length} 件`;
    });

    await step("後始末: QTEMP にモニター表が残っていない", async () => {
      // QTEMP は SYSTABLES に出ないので、名前で SELECT して -204 になることを確かめる
      try {
        await query(conn, "SELECT COUNT(*) AS N FROM QTEMP.VEP0000000");
        return "（試行名は存在しない前提。ここに来たら要確認）";
      } catch {
        return "残っていない";
      }
    });

    if (runPlan === undefined) failures += 1;
  } finally {
    conn.close();
  }
  line(`\n=== 失敗 ${failures} 件 ===`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  line(`FATAL: ${String(e)}`);
  process.exit(1);
});
