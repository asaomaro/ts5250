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
// **ワークスペース参照（@ts5250/*）は実体コピーにする。** npm の workspaces に任せると
// node_modules 側がシンボリックリンクになり、electron-builder の複写や Windows での展開で
// 壊れうる（`--install-links` を付けても workspace はリンクのまま作られる。実測）。
// そこで npm には**第三者依存だけ**を解決させ、自前パッケージは後から実体で置く。
//
// 出来上がり（= 配布物の resources/app/）:
//   app-stage/
//     package.json                       … 第三者依存の宣言（npm install の入力）
//     node_modules/                      … 第三者依存 ＋ @ts5250/*（実体コピー）
//     packages/web-ui/dist               … 静的アセット（--web-root が cwd 相対で読む）
import { execSync } from "node:child_process";
import {
  cpSync,
  mkdirSync,
  rmSync,
  writeFileSync,
  readFileSync,
  readdirSync,
  statSync,
  existsSync
} from "node:fs";
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
requireBuilt(join(REPO, "packages", "web-ui", "dist", "index.html"), "npm run build -w @ts5250/web-ui");

// 第三者依存は**各 package.json から集める**（ここに書き写すと、依存を足したときに
// 配布物だけ古いという最悪の壊れ方をする）
const thirdParty = {};
for (const name of LIB_PACKAGES) {
  const deps = readJson(join(REPO, "packages", name, "package.json")).dependencies ?? {};
  for (const [dep, range] of Object.entries(deps)) {
    if (!dep.startsWith("@ts5250/")) thirdParty[dep] = range;
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
/**
 * **npm は shell 経由で起動する（`execSync`）。**
 *
 * Windows の `npm` の実体は `npm.cmd` というバッチで、Node は CVE-2024-27980 の対策以降
 * `.cmd` / `.bat` を shell 無しでは起動できない——`execFileSync("npm.cmd", …)` は
 * `spawnSync npm.cmd EINVAL` で落ちる（Windows の Node 24 で実際に踏んだ）。
 *
 * かといって `execFileSync(…, { shell: true })` は引数配列を連結するだけなので Node 24 が
 * DEP0190 を出す。**コマンド文字列を渡す `execSync` が、この用途に用意された API**。
 * 渡すのは**この場で書いた定数だけ**（cwd は文字列に混ぜずオプションで渡す）なので、
 * 外から値が入り込む余地は無い。
 */
try {
  execSync("npm install --omit=dev --no-audit --no-fund --loglevel=error", {
    cwd: STAGE,
    stdio: "inherit"
  });
} catch (err) {
  // 生の Node スタックを出さない——ここで落ちる原因はほぼ「npm が無い / ネットワーク」なので、
  // 読み手に必要なのは何をすればいいかだけ
  log(`依存の解決に失敗しました: ${err instanceof Error ? err.message : String(err)}`);
  log("npm が使えること・ネットワークに繋がることを確認してからやり直してください。");
  process.exit(1);
}

log("==> 自前パッケージを node_modules へ実体コピー");
for (const name of LIB_PACKAGES) {
  const from = join(REPO, "packages", name);
  const to = join(STAGE, "node_modules", "@ts5250", name);
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

/**
 * 実行に要らないものを落とす。
 *
 * **配布物の大きさは起動の速さに直結する**——portable exe は起動のたびに全体を展開し直し、
 * Windows ではその 1 ファイルずつをウイルス対策が走査する。ソースマップと型定義は
 * 実行時に一度も読まれないので、入れておく理由が無い。
 *
 * **ライセンス表記（LICENSE / NOTICE）と README は残す。** 再配布物なので、
 * 大きさのために取り除いてよいものではない。
 */
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
