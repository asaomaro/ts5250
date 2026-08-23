// 実機で**取得量の上限が実際に効いているか**を、MCP と REST の両方の入口で確かめる。
//
// 単体テストは偽の接続で「要求したブロッキング係数」を固定しているだけなので、
// **実機で本当に速く・小さくなったか**はここで測る。
// 比較の相手は research（`research-sql-cancel.mjs`）で採った全件取得の実測値:
// 20,000 行 × CHAR(50) で **201 往復 / 1,191,336 バイト / 2,072ms**。
//
// 実行: AS400_PASSWORD=... node scripts/verify-sql-limit.mjs
import { readFileSync } from "node:fs";
import { DbConnection, executeStatement, query } from "@ts5250/tn5250";
import {
  buildApp,
  SessionManager,
  ServerConfigStore,
  PersonalConfigStore,
  ConfigResolver
} from "@ts5250/server";
// **MCP のツール登録は公開 API に無い**ので dist から直接読む（登録コードそのものを通したい）
import { registerHostServerTools } from "../packages/server/dist/host-server-tools.js";

const out = (s) => process.stdout.write(s + "\n");
const LIB = process.env.AS400_LIB ?? "TESTLIB";
const T = "SQLLIMIT";
const ROWS = 20000;

const results = [];
const check = (n, ok, d = "") => {
  results.push({ n, ok });
  out(`${ok ? "OK  " : "NG  "} ${n}${d ? ` — ${d}` : ""}`);
};

const cfg = JSON.parse(readFileSync("connections.json", "utf8"));
const sys = cfg.systems.find((s) => s.name === (process.env.AS400_SYSTEM ?? "AS400"));
const password = process.env.AS400_PASSWORD;
if (!password) {
  out("AS400_PASSWORD が未設定です");
  process.exit(1);
}
// **設定に書くのは環境変数の名前だけ**（値はファイルに落とさない）
const forApp = JSON.parse(JSON.stringify(cfg));
forApp.systems.find((s) => s.name === (process.env.AS400_SYSTEM ?? "AS400")).signon = {
  user: sys.signon.user,
  passwordEnv: "AS400_PASSWORD"
};

const connect = () =>
  DbConnection.connect({
    host: sys.host,
    user: sys.signon.user,
    password,
    ...(sys.tls !== undefined ? { tls: sys.tls } : {})
  });

/** MCP の `host_sql` ハンドラを捕まえる（実際の登録コードを通す） */
function captureTools(deps) {
  const tools = new Map();
  const fake = {
    registerTool: (name, _meta, handler) => tools.set(name, handler),
    registerResource: () => undefined,
    registerPrompt: () => undefined
  };
  registerHostServerTools(fake, deps);
  return tools;
}

let setup;
try {
  // --- 準備: 20,000 行の表 ---
  setup = await connect();
  await executeStatement(setup, `DROP TABLE ${LIB}.${T}`).catch(() => undefined);
  await executeStatement(setup, `CREATE TABLE ${LIB}.${T} (ID INT, S CHAR(50))`);
  await executeStatement(
    setup,
    `INSERT INTO ${LIB}.${T} ` +
      `WITH N(I) AS (VALUES(1) UNION ALL SELECT I + 1 FROM N WHERE I < ${ROWS}) ` +
      `SELECT I, 'padding padding padding padding' FROM N`
  );
  const total = await query(setup, `SELECT COUNT(*) AS N FROM ${LIB}.${T}`);
  out(`準備: ${LIB}.${T} に ${total.rows[0].N} 行\n`);

  const resolver = new ConfigResolver(
    new ServerConfigStore(forApp),
    new PersonalConfigStore({ systems: [], sessions: [] })
  );
  const deps = { sessions: new SessionManager(), resolver, version: "verify" };

  // --- MCP 経路 ---
  const tools = captureTools(deps);
  const hostSql = tools.get("host_sql");
  check("host_sql が登録されている", typeof hostSql === "function");

  const t0 = Date.now();
  const res = await hostSql({
    system: "srv:" + forApp.systems.find((s) => s.name === (process.env.AS400_SYSTEM ?? "AS400")).id,
    sql: `SELECT ID, S FROM ${LIB}.${T} ORDER BY ID`,
    maxRows: 200
  });
  const mcpMs = Date.now() - t0;
  const body = JSON.parse(res.content[0].text);
  check("**MCP: 上限 200 で 200 行返る**", body.rowCount === 200, `rowCount=${body.rowCount}`);
  check("**MCP: 続きがあると分かる**", body.truncated === true, `truncated=${body.truncated}`);
  check("列メタデータが付く", body.columns?.length === 2, JSON.stringify(body.columns?.map((c) => c.name)));
  // 全件取得（研究の実測 2,072ms ＋ 接続 4〜6 秒）に対し、接続込みでも十分速いこと
  out(`     MCP の所要（接続込み）: ${mcpMs}ms`);

  // 上限ちょうど（200 行の表を上限 200 で読む）で嘘をつかないか
  const exact = JSON.parse(
    (
      await hostSql({
        system: "srv:" + forApp.systems.find((s) => s.name === (process.env.AS400_SYSTEM ?? "AS400")).id,
        sql: `SELECT ID FROM ${LIB}.${T} WHERE ID <= 200 ORDER BY ID`,
        maxRows: 200
      })
    ).content[0].text
  );
  check(
    "**MCP: 上限ちょうどでは truncated が false**",
    exact.rowCount === 200 && exact.truncated === false,
    `rowCount=${exact.rowCount} truncated=${exact.truncated}`
  );

  // --- REST 単発経路 ---
  const app = buildApp({ ...deps, version: "verify" });
  const post = (body) =>
    app.request("/api/host/sql", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body)
    });
  const src = { system: "srv:" + forApp.systems.find((s) => s.name === (process.env.AS400_SYSTEM ?? "AS400")).id };
  const t1 = Date.now();
  const restRes = await post({ source: src, sql: `SELECT ID, S FROM ${LIB}.${T} ORDER BY ID`, maxRows: 50 });
  const restMs = Date.now() - t1;
  const rest = await restRes.json();
  check("**REST 単発: 上限 50 で 50 行返る**", rest.rowCount === 50, `rowCount=${rest.rowCount}`);
  check("**REST 単発: 続きがあると分かる**", rest.truncated === true, `truncated=${rest.truncated}`);
  out(`     REST の所要（接続込み）: ${restMs}ms`);

  // --- 打ち切り後もホストは健全（別接続で確認）---
  const after = await query(setup, `SELECT COUNT(*) AS N FROM ${LIB}.${T}`);
  check("打ち切り後も表は読める", Number(after.rows[0].N) === ROWS, `${after.rows[0].N} 行`);
} catch (e) {
  check("例外なく完走", false, e instanceof Error ? e.message : String(e));
  out(e?.stack ?? "");
} finally {
  try {
    if (setup && !setup.isClosed) await executeStatement(setup, `DROP TABLE ${LIB}.${T}`).catch(() => undefined);
  } catch {
    /* 後片付けの失敗は結論に影響しない */
  }
  setup?.close?.();
}

const failed = results.filter((r) => !r.ok);
out(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length === 0 ? 0 : 1);
