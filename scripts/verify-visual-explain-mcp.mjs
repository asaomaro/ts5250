/**
 * 実行計画の MCP ツールを実機で確かめる。
 *
 *   node --env-file=.env scripts/verify-visual-explain-mcp.mjs           # 実機 (7.3・全特権)
 *   node --env-file=.env scripts/verify-visual-explain-mcp.mjs pub400    # PUB400 (7.5・特権なし)
 *
 * 見るもの:
 *   - `host_sql_explain` が計画を構造化データで返す
 *   - **既定が `no-rows`**（`run` を既定にすると「この DELETE を explain して」で削除が走る）
 *   - `detail` を指定しないとノードの属性を返さない（トークン量を抑える）
 *   - `host_plan_list` が特権の有無で `available` を切り替え、**理由を返す**
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";

const which = process.argv[2] === "pub400" ? "pub400" : "as400";
const SYS_NAME = which === "pub400" ? "pub400" : "実機";
const PASSWORD_ENV = which === "pub400" ? "PUB400_PASSWORD" : "AS400_PASSWORD";
const TMP = "/tmp/as400-verify-ve-mcp";

const results = [];
const check = (n, ok, d = "") => {
  results.push({ n, ok });
  process.stdout.write(`${ok ? "OK  " : "NG  "} ${n}${d ? ` — ${d}` : ""}\n`);
};

if (!process.env[PASSWORD_ENV]) {
  process.stderr.write(`${PASSWORD_ENV} が未設定です\n`);
  process.exit(1);
}

// **資格情報は passwordEnv で渡す**（値をファイルに落とさない）
const cfg = JSON.parse(readFileSync("connections.json", "utf8"));
const sys = cfg.systems.find((s) => s.name === SYS_NAME);
sys.signon = {
  user: sys.signon?.user ?? process.env[which === "pub400" ? "PUB400_USER" : "AS400_USER"],
  passwordEnv: PASSWORD_ENV
};
mkdirSync(TMP, { recursive: true });
const tmpCfg = `${TMP}/conn.json`;
writeFileSync(tmpCfg, JSON.stringify(cfg));
const SYSTEM = `srv:${sys.id}`;

const transport = new StdioClientTransport({
  command: "node",
  args: ["packages/server/dist/main.js", "--stdio", "--profiles", tmpCfg],
  env: process.env
});
const client = new Client({ name: "verify-ve-mcp", version: "0" });
await client.connect(transport);

async function call(name, args) {
  const r = await client.callTool({ name, arguments: args });
  return { isError: Boolean(r.isError), text: r.content?.[0]?.text ?? "", data: r.structuredContent };
}

const SQL = "SELECT COUNT(*) AS N FROM QSYS2.SYSCOLUMNS WHERE TABLE_SCHEMA = 'QSYS2'";

try {
  process.stdout.write(`### ${which}（${SYS_NAME}）MCP 検証\n\n`);

  // --- ツールが登録されているか ---
  const tools = await client.listTools();
  const names = tools.tools.map((t) => t.name);
  check("ツールが登録されている", names.includes("host_sql_explain") && names.includes("host_plan_list"),
    `${names.filter((n) => n.startsWith("host_sql_explain") || n.startsWith("host_plan_list")).join(", ")}`);

  // --- host_sql_explain（既定） ---
  const def = await call("host_sql_explain", { system: SYSTEM, sql: SQL });
  check("host_sql_explain が成功する", !def.isError, def.isError ? def.text.slice(0, 160) : "");
  const plan = def.data;
  check("計画のノードを返す", (plan?.nodes?.length ?? 0) > 0, `nodes=${plan?.nodes?.length} / nodeCount=${plan?.nodeCount}`);
  check("**既定は no-rows**（更新系を勝手に実行しない）", plan?.captured === "no-rows", `captured=${plan?.captured}`);
  check("要約を返す", Boolean(plan?.summary?.tables?.length), `tables=${plan?.summary?.tables}`);
  check("種別に名前が付いている", plan?.nodes?.some((n) => n.kind === "table-scan"),
    `kinds=${[...new Set(plan?.nodes?.map((n) => n.kind) ?? [])].join(", ")}`);
  check("**既定では属性を返さない**（トークン量を抑える）", plan?.nodes?.every((n) => n.attributes === undefined));
  check("切ったかを示す", typeof plan?.truncated === "boolean", `truncated=${plan?.truncated}`);
  check("未対応の記録種別を返す", Array.isArray(plan?.unknownRecordTypes), `[${plan?.unknownRecordTypes?.join(", ")}]`);

  // --- detail 指定 ---
  const detailed = await call("host_sql_explain", { system: SYSTEM, sql: SQL, detail: true });
  check("detail:true で属性が付く", detailed.data?.nodes?.some((n) => Array.isArray(n.attributes) && n.attributes.length > 0));

  // --- 更新系を既定で拒む ---
  const del = await call("host_sql_explain", { system: SYSTEM, sql: "DELETE FROM QTEMP.NOPE_NEVER" });
  check("**更新系は既定で拒まれる**（mode を明示しない限り実行しない）",
    del.isError && /SELECT 系の文でのみ/u.test(del.text), del.text.slice(0, 120));

  // --- run を明示すれば動く（SELECT で確認。DELETE は実行しない） ---
  const run = await call("host_sql_explain", { system: SYSTEM, sql: SQL, mode: "run" });
  check("mode=run を明示すれば run で採れる", run.data?.captured === "run", `captured=${run.data?.captured}`);

  // --- 索引の助言 ---
  check("索引の助言を返す（あれば CREATE INDEX 文つき）",
    Array.isArray(plan?.advice) && (plan.advice.length === 0 || Boolean(plan.advice[0].createStatement)),
    plan?.advice?.[0]?.createStatement ?? "(助言なし)");

  // --- host_plan_list ---
  const list = await call("host_plan_list", { system: SYSTEM, topN: 5 });
  check("host_plan_list が成功する（例外にしない）", !list.isError, list.isError ? list.text.slice(0, 160) : "");
  if (which === "pub400") {
    check("**特権が無いと available:false**", list.data?.available === false, `${list.data?.reason}`);
    check("理由に *JOBCTL を書く", String(list.data?.reason ?? "").includes("*JOBCTL"), `${list.data?.reason}`);
  } else {
    check("特権があれば一覧が返る", list.data?.available === true && (list.data?.count ?? 0) > 0,
      `count=${list.data?.count}`);
  }
} finally {
  await client.close();
}

const ng = results.filter((r) => !r.ok).length;
process.stdout.write(`\n=== ${results.length} 件中 失敗 ${ng} 件 ===\n`);
process.exit(ng === 0 ? 0 : 1);
