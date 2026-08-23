/**
 * 実行計画の統合検証（REST 経由・実機）。
 *
 *   node --env-file=.env scripts/verify-visual-explain-e2e.mjs            # 実機 (7.3・全特権)
 *   node --env-file=.env scripts/verify-visual-explain-e2e.mjs pub400     # PUB400 (7.5・特権なし)
 *
 * `20260802-sql-visual-explain` の受け入れ基準を、**サーバーの REST を通して**確かめる
 * （`verify-visual-explain.mjs` は hostserver の関数を直接叩く疎通確認）。
 *
 * 見るもの:
 *   - `POST /api/host/sql/explain` の `run` / `no-rows`
 *   - `no-rows` が非クエリ文を**理由付きで**断る
 *   - `GET /api/host/plans`（特権があれば一覧、無ければ `available:false` ＋ 理由）
 *   - `GET /api/host/plans/:id`
 *   - **既存 SQL 経路の非退行**（`/api/host/sql` の通常実行・ページング）
 *   - **explain 専用プールが通常の SQL と混線しない**
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import {
  buildApp,
  SessionManager,
  ServerConfigStore,
  PersonalConfigStore,
  ConfigResolver
} from "@ts5250/server";

const which = process.argv[2] === "pub400" ? "pub400" : "as400";
const SYS_NAME = which === "pub400" ? "pub400" : (process.env.AS400_SYSTEM ?? "AS400");
const PASSWORD_ENV = which === "pub400" ? "PUB400_PASSWORD" : "AS400_PASSWORD";
const TMP = "/tmp/as400-verify-visual-explain";

const results = [];
const check = (n, ok, d = "") => {
  results.push({ n, ok });
  process.stdout.write(`${ok ? "OK  " : "NG  "} ${n}${d ? ` — ${d}` : ""}\n`);
};

if (!process.env[PASSWORD_ENV]) {
  process.stderr.write(`${PASSWORD_ENV} が未設定です\n`);
  process.exit(1);
}

const cfg = JSON.parse(readFileSync("connections.json", "utf8"));
const sys = cfg.systems.find((s) => s.name === SYS_NAME);
if (!sys) {
  process.stderr.write(`connections.json に ${SYS_NAME} がありません\n`);
  process.exit(1);
}
// **値はファイルに落とさない**（環境変数の名前だけ書く）
sys.signon = { user: sys.signon?.user ?? process.env[which === "pub400" ? "PUB400_USER" : "AS400_USER"], passwordEnv: PASSWORD_ENV };
mkdirSync(TMP, { recursive: true });
const tmpCfg = `${TMP}/conn.json`;
writeFileSync(tmpCfg, JSON.stringify(cfg));

const resolver = new ConfigResolver(
  ServerConfigStore.fromFile(tmpCfg),
  new PersonalConfigStore({ systems: [], sessions: [] })
);
const app = buildApp({ sessions: new SessionManager(), resolver, version: "verify" });
const SOURCE = { system: `srv:${sys.id ?? sys.name}` };

async function post(path, body) {
  const res = await app.request(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
  return { status: res.status, body: await res.json() };
}
async function get(path) {
  const res = await app.request(path);
  return { status: res.status, body: await res.json() };
}

const SQL = "SELECT COUNT(*) AS N FROM QSYS2.SYSCOLUMNS WHERE TABLE_SCHEMA = 'QSYS2'";

async function main() {
  process.stdout.write(`### ${which}（${SYS_NAME}）REST 統合検証\n\n`);

  // --- 1. run モード ---
  const run = await post("/api/host/sql/explain", { source: SOURCE, sql: SQL, mode: "run" });
  check("run: 200 が返る", run.status === 200, `status=${run.status} ${JSON.stringify(run.body).slice(0, 160)}`);
  const runPlan = run.body?.plan;
  check("run: 計画のノードがある", (runPlan?.summary?.nodeCount ?? 0) > 0, `nodes=${runPlan?.summary?.nodeCount}`);
  check("run: 走査した表が分かる", (runPlan?.summary?.tables?.length ?? 0) > 0, `${runPlan?.summary?.tables}`);
  check("run: 結果行も返る", Array.isArray(run.body?.rows) && run.body.rows.length > 0, `rows=${run.body?.rows?.length}`);
  check("run: 採取モードが run", runPlan?.captured === "run");

  // --- 2. no-rows モード ---
  const noRows = await post("/api/host/sql/explain", { source: SOURCE, sql: SQL, mode: "no-rows" });
  check("no-rows: 200 が返る", noRows.status === 200, `status=${noRows.status}`);
  check("no-rows: 計画は採れる", (noRows.body?.plan?.summary?.nodeCount ?? 0) > 0);
  check("no-rows: **行は返らない**", noRows.body?.rows === undefined);

  // --- 3. no-rows が非クエリ文を断る ---
  const rejected = await post("/api/host/sql/explain", {
    source: SOURCE,
    sql: "CREATE TABLE QTEMP.NEVER_CREATED (A INT)",
    mode: "no-rows"
  });
  check(
    "no-rows: 非クエリ文を**理由付きで**断る",
    rejected.status >= 400 && String(rejected.body?.error).includes("SELECT 系の文でのみ"),
    `status=${rejected.status} ${rejected.body?.error}`
  );
  // **断ったのに表ができていないこと**を確かめる（副作用を起こしていない）
  const notCreated = await post("/api/host/sql", { source: SOURCE, sql: "SELECT * FROM QTEMP.NEVER_CREATED" });
  check("no-rows: 断った文の副作用が無い", notCreated.status >= 400, `status=${notCreated.status}`);

  // --- 4. 索引の助言 ---
  const advice = runPlan?.advice ?? [];
  check("助言: CREATE INDEX 文まで組み立てている", advice.length === 0 || Boolean(advice[0]?.createStatement),
    advice[0]?.createStatement ?? "(助言なし)");

  // --- 5. 記録種別の命名と版数差 ---
  const nodes = (runPlan?.blocks ?? []).flatMap((b) => b.nodes ?? []);
  const kinds = [...new Set(nodes.map((n) => n.kind))];
  check("命名: 表の走査が種別として出る", kinds.includes("table-scan"), `kinds=${kinds.join(", ")}`);
  check("命名: 索引の使用が種別として出る", kinds.includes("index-used"), `kinds=${kinds.join(", ")}`);
  check(
    "命名: **ステップと付帯情報が分かれている**",
    nodes.some((n) => n.category === "step") && nodes.some((n) => n.category === "info"),
    `step=${runPlan?.summary?.stepCount} / 計=${runPlan?.summary?.nodeCount}`
  );
  // 7.5 だけに出る 3015（Statistics Information）はノードとして見える
  const hasStats = nodes.some((n) => n.recordType === 3015);
  if (which === "pub400") {
    check("版数差: **7.5 だけの統計情報(3015)がノードとして出る**", hasStats, `kinds=${kinds.join(", ")}`);
  } else {
    check("版数差: 7.3 に 3015 は出ない", !hasStats, `kinds=${kinds.join(", ")}`);
  }
  const unknown = runPlan?.unknownRecordTypes ?? [];
  check("未対応種別: 名前を付けたものは数えない", !unknown.includes(3015) && !unknown.includes(3000), `[${unknown.join(", ")}]`);
  check("未対応種別: 意図して使う 1000 / 3019 も数えない", !unknown.includes(1000) && !unknown.includes(3019));

  // --- 6. プランキャッシュ一覧（特権で分かれる） ---
  const list = await get(`/api/host/plans?system=${encodeURIComponent(SOURCE.system)}&topN=5`);
  const listBody = list.body;
  if (which === "pub400") {
    check("一覧: **特権が無いので無効化される**", listBody?.available === false, `${listBody?.reason}`);
    check("一覧: 理由に *JOBCTL を書く", String(listBody?.reason).includes("*JOBCTL"), `${listBody?.reason}`);
    check("一覧: **空一覧で黙らない**", String(listBody?.reason ?? "").length > 0);
  } else {
    check("一覧: 参照できる", listBody?.available === true, `${listBody?.reason ?? ""}`);
    check("一覧: 件数がある", (listBody?.items?.length ?? 0) > 0, `items=${listBody?.items?.length}`);
    const first = listBody?.items?.[0];
    if (first) {
      const one = await get(
        `/api/host/plans/${encodeURIComponent(first.id)}?system=${encodeURIComponent(SOURCE.system)}&topN=5`
      );
      check("一覧から計画を開ける", one.status === 200 && (one.body?.plan?.summary?.nodeCount ?? 0) >= 0,
        `status=${one.status}`);
      check("一覧由来の採取モードは plan-cache", one.body?.plan?.captured === "plan-cache");
    }
  }

  // --- 7. 既存 SQL 経路の非退行 ---
  const plain = await post("/api/host/sql", { source: SOURCE, sql: SQL });
  check("非退行: /api/host/sql が通る", plain.status === 200 && plain.body?.rowCount === 1, `status=${plain.status}`);
  const paged = await post("/api/host/sql", {
    source: SOURCE,
    sql: "SELECT TABLE_NAME FROM QSYS2.SYSTABLES WHERE TABLE_SCHEMA = 'QSYS2'",
    pageSize: 5
  });
  check("非退行: ページングが通る", paged.status === 200 && paged.body?.rows?.length === 5,
    `status=${paged.status} rows=${paged.body?.rows?.length}`);
  check("非退行: 続きがある印が返る", paged.body?.hasMore === true);

  // --- 8. explain と通常 SQL を交互に流しても混線しない ---
  const a = await post("/api/host/sql/explain", { source: SOURCE, sql: SQL, mode: "no-rows" });
  const b = await post("/api/host/sql", { source: SOURCE, sql: SQL });
  const c = await post("/api/host/sql/explain", { source: SOURCE, sql: SQL, mode: "no-rows" });
  check("混線しない: explain → SQL → explain がすべて成功",
    a.status === 200 && b.status === 200 && c.status === 200,
    `${a.status}/${b.status}/${c.status}`);

  const ng = results.filter((r) => !r.ok).length;
  process.stdout.write(`\n=== ${results.length} 件中 失敗 ${ng} 件 ===\n`);
  process.exit(ng === 0 ? 0 : 1);
}

main().catch((e) => {
  process.stdout.write(`FATAL: ${String(e)}\n${e instanceof Error ? e.stack : ""}\n`);
  process.exit(1);
});
