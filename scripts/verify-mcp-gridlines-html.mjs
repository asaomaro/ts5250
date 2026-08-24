// **MCP が出す HTML にも罫線が入っているか**を実機で確かめる（S9R167D の再現画面）。
//
// `get_screen_html` は自動操作のエビデンス用に「画面をそのまま人に見せられる形」で出す。
// 画面バッファ（`verify-gridlines-clear-unit.mjs`）と web-ui（`verify-browser-gridlines.mjs`）が
// 直っても、**MCP の HTML は別の描画系**（`packages/tn5250/src/screen-html.ts`）なので、
// ここでも罫線が出ることを見て初めて「どの出口から見ても直った」と言える。
//
// 検証資材は scripts/build-gridtest6.mjs が作る <LIB>/GRIDTST6 ＋ GRIDCL8 / GRIDCL9。
//
// 実行:
//   npm run build
//   node --env-file=.env --env-file=.env.verify scripts/verify-mcp-gridlines-html.mjs
// 任意: MCP_HTML_OUT（HTML の出力先ディレクトリ。既定 /tmp）
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const LIB = process.env.AS400_LIB ?? "TESTLIB";
const SYSTEM = process.env.AS400_SYSTEM ?? "AS400";
const OUT = process.env.MCP_HTML_OUT ?? tmpdir();
const EXPECTED_LINES = 13; // build-gridtest6.mjs の GRID_LINES と揃える
const log = (s) => process.stderr.write(s + "\n");
/**
 * 画面テキストの照合用に空白を落とす。**MCP の固定形式は全角 1 文字を 2 桁に見せる**ため
 * 「サ イ ン ・ オ ン」のように 1 文字ごとに空白が入る——素の `includes` では当たらない。
 */
const flat = (t) => (t ?? "").replace(/[\s]+/g, "");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
const check = (cond, msg) => { if (cond) { pass++; log(`  PASS ${msg}`); } else { fail++; log(`  FAIL ${msg}`); } };

const transport = new StdioClientTransport({
  command: "node",
  args: ["packages/server/dist/main.js", "--stdio", "--profiles", "profiles.local.json"],
  env: process.env
});
const client = new Client({ name: "verify-mcp-gridlines", version: "0" });
await client.connect(transport);

const call = async (name, args) => {
  const r = await client.callTool({ name, arguments: args });
  if (r.isError) throw new Error(`${name} failed: ${r.content?.[0]?.text}`);
  return r;
};

let sessionId;
try {
  // **システムを指定して開く**（セッション設定は装置名を持つ＝共有機で既存の装置を奪いかねない）。
  // system 指定なら装置名はホストが採る。
  const systems = (await call("list_systems", {})).structuredContent.systems;
  const sys = systems.find((s) => s.name === SYSTEM) ?? systems[0];
  check(Boolean(sys), `システム ${SYSTEM} が設定にある`);
  if (!sys) throw new Error("システムが無い");
  const open = await call("open_session", { system: sys.ref, screenSize: "24x80" });
  sessionId = open.structuredContent.sessionId;
  check(Boolean(sessionId), `open_session（${sys.ref}・24x80）`);

  // コマンド行まで進める。**サインオン画面はここで通す**——`system` 指定で開くと
  // セッション設定の自動サインオンは効かない（装置名を奪わないための指定なので、ここは手で通す）。
  for (let i = 0; i < 8; i++) {
    const scr = (await call("get_screen", { sessionId, include: ["grid", "fields"] })).structuredContent;
    const t = scr.text ?? "";
    if (process.env.VERIFY_DEBUG === "1") log("screen:\n" + t.split("\n").slice(0, 24).join("\n"));
    if (flat(t).includes("コマンドを入力") || flat(t).includes("選択項目またはコマンド")) break;
    const inputs = scr.fields.filter((f) => !f.protected);
    if (flat(t).includes("サイン・オン") && inputs.length >= 2) {
      await call("set_fields", {
        sessionId,
        fields: [
          { field: inputs[0].index, value: process.env.AS400_USER },
          { field: inputs[1].index, value: process.env.AS400_PASSWORD }
        ]
      });
    } else if (flat(t).includes("回復") && inputs[0]) {
      await call("set_fields", { sessionId, fields: [{ field: inputs[0].index, value: "90" }] });
    }
    await call("send_key", { sessionId, key: "Enter" });
    await sleep(1800);
  }

  for (const pgm of ["GRIDCL8", "GRIDCL9"]) {
    log(`\n### ${pgm}`);
    const scr = (await call("get_screen", { sessionId, include: ["fields"] })).structuredContent;
    const cmd = scr.fields.filter((f) => !f.protected).find((f) => f.length > 20);
    check(Boolean(cmd), `${pgm}: コマンド行がある`);
    if (!cmd) break;
    await call("set_fields", { sessionId, fields: [{ field: cmd.index, value: `CALL ${LIB}/${pgm}` }] });
    await call("send_key", { sessionId, key: "Enter" });
    await sleep(2000);

    const html = (await call("get_screen_html", { sessionId, title: `GRIDTST6 ${pgm}`, note: "罫線 + CLEAR UNIT の再現" }))
      .structuredContent.html;
    const file = join(OUT, `mcp-gridlines-${pgm}.html`);
    writeFileSync(file, html);
    // 罫線は `.gl-h`（横）/ `.gl-v`（縦）の div として出る（screen-html.ts）
    const drawn = (html.match(/class="[^"]*\bgl-[hv]\b/g) ?? []).length;
    log(`  出力: ${file}（${html.length} バイト） / 罫線 ${drawn} 本`);
    check(html.includes("13 LINES MUST SHOW"), `${pgm}: 画面の本文が HTML に入っている`);
    check(drawn === EXPECTED_LINES, `${pgm}: HTML に罫線が ${EXPECTED_LINES} 本入っている（実際 ${drawn} 本）`);
    check(!/<link|<script src|https?:\/\//.test(html), `${pgm}: 自己完結（外部参照が無い）`);

    // 画面を閉じてコマンド行へ戻す
    for (let i = 0; i < 4; i++) {
      const t = (await call("get_screen", { sessionId, include: ["grid"] })).structuredContent.text ?? "";
      if (flat(t).includes("コマンドを入力")) break;
      await call("send_key", { sessionId, key: "Enter" });
      await sleep(1500);
    }
  }
} catch (err) {
  check(false, err instanceof Error ? err.message : String(err));
} finally {
  if (sessionId) await call("close_session", { sessionId }).catch(() => {});
  await client.close();
}

log(`\n${fail === 0 ? "すべて PASS" : `FAIL ${fail} 件`}（PASS ${pass}）`);
process.exit(fail === 0 ? 0 : 1);
