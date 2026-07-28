// 配布用アプリ一式（app-stage/）を組み立てる。electron-builder はこれを丸ごと同梱する。
//
// **なぜ staging が要るか**: サーバーは実行時に hono / ws / pino / pdfkit / zod /
// @modelcontextprotocol/sdk を import する。これまでは `packages/*/dist` だけを同梱していたので、
// 出来上がった exe は起動時に依存を解決できなかった（開発機では repo の node_modules が
// たまたま見えるので気づけない）。**単独で配布できる exe** にするには、実行時依存を
// アプリの中へ入れる必要がある。
//
// **なぜ repo の node_modules をコピーしないか**: ルートの node_modules には electron・
// playwright・vitest まで入っており、配布物が桁違いに太る。ここでは実行時依存だけを
// npm に解決させる（`--omit=dev`）。
//
// **ワークスペース参照（@as400web/*）は実体コピーにする。** npm の workspaces に任せると
// node_modules 側がシンボリックリンクになり、electron-builder の複写や Windows での展開で
// 壊れうる（`--install-links` を付けても workspace はリンクのまま作られる。実測）。
// そこで npm には**第三者依存だけ**を解決させ、自前パッケージは後から実体で置く。
//
// 出来上がり（= 配布物の resources/app/）:
//   app-stage/
//     package.json                       … 第三者依存の宣言（npm install の入力）
//     node_modules/                      … 第三者依存 ＋ @as400web/*（実体コピー）
//     packages/web-ui/dist               … 静的アセット（--web-root が cwd 相対で読む）
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ELECTRON_DIR = resolve(HERE, "..");
const REPO = resolve(ELECTRON_DIR, "..");
const STAGE = join(ELECTRON_DIR, "app-stage");

/** 実行時に要る自前パッケージ（server が入口。core → ebcdic/scs と辿る） */
const LIB_PACKAGES = ["ebcdic", "scs", "core", "server"];

const log = (s) => process.stderr.write(`${s}\n`);
const readJson = (p) => JSON.parse(readFileSync(p, "utf8"));

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
requireBuilt(join(REPO, "packages", "web-ui", "dist", "index.html"), "npm run build -w @as400web/web-ui");

// 第三者依存は**各 package.json から集める**（ここに書き写すと、依存を足したときに
// 配布物だけ古いという最悪の壊れ方をする）
const thirdParty = {};
for (const name of LIB_PACKAGES) {
  const deps = readJson(join(REPO, "packages", name, "package.json")).dependencies ?? {};
  for (const [dep, range] of Object.entries(deps)) {
    if (!dep.startsWith("@as400web/")) thirdParty[dep] = range;
  }
}

log("==> app-stage を作り直す");
rmSync(STAGE, { recursive: true, force: true });
mkdirSync(STAGE, { recursive: true });

writeFileSync(
  join(STAGE, "package.json"),
  `${JSON.stringify(
    { name: "as400-5250-app", version: "0.0.0", private: true, type: "module", dependencies: thirdParty },
    null,
    2
  )}\n`
);

log(`==> 第三者依存を解決（${Object.keys(thirdParty).sort().join(" ")}）`);
execFileSync(
  process.platform === "win32" ? "npm.cmd" : "npm",
  ["install", "--omit=dev", "--no-audit", "--no-fund", "--loglevel=error"],
  { cwd: STAGE, stdio: "inherit" }
);

log("==> 自前パッケージを node_modules へ実体コピー");
for (const name of LIB_PACKAGES) {
  const from = join(REPO, "packages", name);
  const to = join(STAGE, "node_modules", "@as400web", name);
  rmSync(to, { recursive: true, force: true }); // npm がリンクを張っていても消してから置く
  mkdirSync(to, { recursive: true });
  // package.json は exports / type を運ぶので必須。dist だけでは import が解決できない
  cpSync(join(from, "package.json"), join(to, "package.json"));
  cpSync(join(from, "dist"), join(to, "dist"), { recursive: true });
}

// web-ui は配信されるだけ（--web-root は cwd 相対で読む）
cpSync(join(REPO, "packages", "web-ui", "dist"), join(STAGE, "packages", "web-ui", "dist"), {
  recursive: true
});

log(`==> 完了: ${STAGE}`);
