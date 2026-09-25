// 配布用のサーバー一式（server-stage/）を組み立てる。`vsce package`はこれを丸ごと同梱する。
//
// `electron/scripts/prepare-app.mjs`と同じ問題を解く——サーバーは実行時に hono / ws /
// pino / pdfkit / zod / @modelcontextprotocol/sdk を import するので、`.vsix`単独で
// 動くには実行時依存をサーバーと一緒に同梱する必要がある。ロジックはelectron版をほぼ
// そのまま踏襲する（`02-extension-core/tasks.md`「実装方針」3・
// `04-packaging/tasks.md`「実装方針」1）。
//
// **なぜrepoのnode_modulesをコピーしないか**: ルートのnode_modulesにはvitest・
// typescript・electron等まで入っており、配布物が桁違いに太る。ここでは実行時依存だけを
// npmに解決させる（`--omit=dev`）。
//
// **ワークスペース参照（@ts5250/*）は実体コピーにする。** npmのworkspacesに任せると
// node_modules側がシンボリックリンクになり、`.vsix`への圧縮・展開で壊れうる
// （electron版の実測に基づく判断をそのまま踏襲）。
//
// 出来上がり（= vscode-extension/server-stage/）:
//   server-stage/
//     package.json                       … 第三者依存の宣言（npm installの入力）
//     node_modules/                      … 第三者依存 ＋ @ts5250/*（実体コピー）
//     packages/web-ui/dist               … 静的アセット（--web-rootがcwd相対で読む）
import { execSync } from "node:child_process";
import { cpSync, mkdirSync, rmSync, writeFileSync, readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const EXT_DIR = resolve(HERE, "..");
const REPO = resolve(EXT_DIR, "..");
const STAGE = join(EXT_DIR, "server-stage");

const log = (s) => process.stderr.write(`${s}\n`);
const readJson = (p) => JSON.parse(readFileSync(p, "utf8"));

/** 実行時に要る自前パッケージを、入口（server）から依存を辿って集める（手で並べない） */
function collectLibPackages(entry) {
  const out = [];
  const seen = new Set();
  const visit = (name) => {
    if (seen.has(name)) return;
    seen.add(name);
    const deps = readJson(join(REPO, "packages", name, "package.json")).dependencies ?? {};
    for (const dep of Object.keys(deps)) {
      if (dep.startsWith("@ts5250/")) visit(dep.slice("@ts5250/".length));
    }
    out.push(name); // 依存が先、利用側が後
  };
  visit(entry);
  return out;
}
const LIB_PACKAGES = collectLibPackages("server");

function requireBuilt(p, hint) {
  if (!existsSync(p)) {
    log(`ビルド成果物がありません: ${p}`);
    log(`先に ${hint} を実行してください。`);
    process.exit(1);
  }
}

for (const name of LIB_PACKAGES) {
  requireBuilt(join(REPO, "packages", name, "dist"), "npm run build");
}
requireBuilt(join(REPO, "packages", "web-ui", "dist", "index.html"), "npm run build -w @ts5250/web-ui");

// 第三者依存は各package.jsonから集める（書き写すと配布物だけ古くなる）
const thirdParty = {};
for (const name of LIB_PACKAGES) {
  const deps = readJson(join(REPO, "packages", name, "package.json")).dependencies ?? {};
  for (const [dep, range] of Object.entries(deps)) {
    if (!dep.startsWith("@ts5250/")) thirdParty[dep] = range;
  }
}

log("==> server-stage を作り直す");
rmSync(STAGE, { recursive: true, force: true });
mkdirSync(STAGE, { recursive: true });

writeFileSync(
  join(STAGE, "package.json"),
  `${JSON.stringify({ name: "ts5250-server-stage", version: "0.0.0", private: true, type: "module", dependencies: thirdParty }, null, 2)}\n`
);

log(`==> 第三者依存を解決（${Object.keys(thirdParty).sort().join(" ")}）`);
try {
  // Windowsのnpm.cmdをshell無しで起動できない問題があるためexecSyncを使う
  // （`electron/scripts/prepare-app.mjs`と同じ理由）。渡すのはこの場で書いた定数だけ
  execSync("npm install --omit=dev --no-audit --no-fund --loglevel=error", { cwd: STAGE, stdio: "inherit" });
} catch (err) {
  log(`依存の解決に失敗しました: ${err instanceof Error ? err.message : String(err)}`);
  log("npm が使えること・ネットワークに繋がることを確認してからやり直してください。");
  process.exit(1);
}

log("==> 自前パッケージを node_modules へ実体コピー");
for (const name of LIB_PACKAGES) {
  const from = join(REPO, "packages", name);
  const to = join(STAGE, "node_modules", "@ts5250", name);
  rmSync(to, { recursive: true, force: true });
  mkdirSync(to, { recursive: true });
  cpSync(join(from, "package.json"), join(to, "package.json"));
  cpSync(join(from, "dist"), join(to, "dist"), { recursive: true });
}

// web-uiは配信されるだけ（--web-rootはcwd相対で読む）
cpSync(join(REPO, "packages", "web-ui", "dist"), join(STAGE, "packages", "web-ui", "dist"), { recursive: true });

/** 実行に要らないもの（ソースマップ・型定義）を落として配布物を軽くする */
function pruneDeadWeight(dir) {
  let removed = 0;
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.(map|d\.ts|d\.cts|d\.mts)$/.test(e.name)) {
        removed += statSync(p).size;
        rmSync(p);
      }
    }
  };
  walk(dir);
  return removed;
}
const freed = pruneDeadWeight(join(STAGE, "node_modules"));
log(`==> ソースマップ・型定義を除去（${(freed / 1024 / 1024).toFixed(1)} MB）`);

log(`==> 完了: ${STAGE}`);
