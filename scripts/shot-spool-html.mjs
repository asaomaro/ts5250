// 実機で実際にスプールを1件作り、MCP の host_get_spool(format=html) で HTML に落とす。
// pull 型（ホストサーバー経由）なのでプリンターセッションもライターも要らない。
//
// 実行: node --env-file=.env --env-file=.env.verify scripts/shot-spool-html.mjs <出力先.html>
import { writeFileSync } from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const OUT = process.argv[2] ?? "spool.html";
const log = (s) => process.stderr.write(s + "\n");
const transport = new StdioClientTransport({
  command: "node",
  args: ["packages/server/dist/main.js", "--stdio"],
  env: process.env
});
const client = new Client({ name: "spool-html", version: "0" });
await client.connect(transport);
const call = async (name, args) => {
  const r = await client.callTool({ name, arguments: args });
  if (r.isError) throw new Error(`${name} failed: ${r.content?.[0]?.text}`);
  return r;
};
/** host_* は jsonResult（本文が JSON 文字列）で返る */
const json = (r) => JSON.parse(r.content[0].text);

try {
  const sys = (await call("list_systems", {})).structuredContent.systems;
  const source = { system: sys.find((s) => s.name === (process.env.AS400_SYSTEM ?? "AS400")).ref };

  // 1. 帳票を1件作る（DBCS を含む一覧にしたいので DSPLIB を使う）
  const cmd = json(await call("host_command", { ...source, command: "DSPLIB LIB(TESTLIB) OUTPUT(*PRINT)" }));
  log(`DSPLIB: ok=${cmd.ok ?? cmd.success} ${JSON.stringify(cmd.messages ?? []).slice(0, 120)}`);

  // 2. 自分のスプールを新しい順に探す
  const list = json(await call("host_list_spools", { ...source, filter: { user: "USER" }, max: 20 }));
  log(`スプール ${list.count} 件`);
  const items = list.items;
  const target = items[items.length - 1]; // 一覧はおおむね古い順。最後＝直近
  log(`対象: ${JSON.stringify(target).slice(0, 200)}`);

  const id = {
    jobName: target.jobName, jobUser: target.jobUser, jobNumber: target.jobNumber,
    fileName: target.fileName, fileNumber: target.fileNumber
  };

  // 3. まずテキストで中身を確認（CCSID は実機に合わせて 5026）
  const pages = json(await call("host_get_spool", { ...source, id, format: "pages", ccsid: 5026 }));
  writeFileSync(OUT.replace(/\.html$/, "") + "-pages.json", JSON.stringify(pages));
  log(`ページ数 ${pages.pages.length} / 1ページ目 ${pages.pages[0]?.rows} 行 × ${pages.pages[0]?.cols} 桁`);
  for (const l of (pages.pages[0]?.lines ?? []).slice(0, 8)) log("  | " + l);

  // 4. HTML
  const html = json(await call("host_get_spool", {
    ...source, id, format: "html", ccsid: 5026,
    title: `実機スプール ${target.fileName}`,
    note: `DSPLIB LIB(TESTLIB) OUTPUT(*PRINT) / CCSID 5026 — MCP host_get_spool(format=html)`
  }));
  writeFileSync(OUT, html.html);
  log(`wrote ${OUT} (${html.bytes} bytes)`);
} catch (err) {
  log("ERROR: " + err.message);
  process.exitCode = 1;
} finally {
  await client.close();
}
