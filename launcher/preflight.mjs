// 起動前の門番。**start / electron の 4 つのランチャー（.sh / .bat）から共通で呼ぶ。**
//
// ここに集めたのは、4 つに書き写すと必ずずれる 2 つの判定:
//
//   --check-node   … Node が `engines.node` を満たすか（満たさなければ 1 で終わる）
//   --needs-build  … 成果物がソースより古くないか（`1`=要ビルド / `0`=最新 を出す）
//
// **どちらも「黙って古い画面が出る」を防ぐためにある。** 実際に踏んだ:
// 別環境でビルドが落ち（rolldown のネイティブバイナリ取得に失敗）、古い `dist` が
// 残ったまま起動したので、3 週間前の UI が配信され続けていた。画面はふつうに動くので
// **機能がデグレしたようにしか見えない**——原因に辿り着くまでが遠い壊れ方をする。
//
// 判定を .bat 側に書き写さないのは、**cmd の引用符地獄を避ける**ためでもある
// （`&&` `>=` `|` はどれも cmd の演算子で、`for /f` の中では書き方が変わる）。
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// ランチャーは repo 直下から呼ぶが、cwd に依存しないよう自分の位置から辿る
const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
process.chdir(REPO);

/**
 * `engines.node` を満たすか。
 *
 * **対応するのは `^X.Y.Z` と `>=X.Y.Z` を `||` で繋いだ形だけ**——semver を丸ごと実装する
 * 必要は無く、ここで使う宣言はその 2 つで足りる。**読めない形しか無ければ通す**
 * ——門番が誤って止めるほうが、通しすぎるより害が大きい。
 */
export function satisfies(version, range) {
  const cur = version.split(".").map((n) => parseInt(n, 10));
  const cmp = (a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
  let known = false;
  for (const term of range.split("||").map((s) => s.trim())) {
    const m = /^(\^|>=)(\d+)\.(\d+)\.(\d+)$/.exec(term);
    if (!m) continue;
    known = true;
    const min = [Number(m[2]), Number(m[3]), Number(m[4])];
    if (cmp(cur, min) < 0) continue;
    if (m[1] === "^" && cur[0] !== min[0]) continue; // ^ は major を跨がない
    return true;
  }
  return !known;
}

/** ランチャーが配信・同梱するもの。**両方**揃っていて初めて「ビルド済み」 */
const OUTPUTS = ["packages/server/dist/main.js", "packages/web-ui/dist/index.html"];

/**
 * 新しさを測る基準。**vite は毎回 `index.html` を書き直す**ので、これが
 * 「最後に成功したビルド」の時刻になる。
 *
 * 成果物そのものの mtime では測れない——`tsc -b` は増分なので、**変わらなかった出力には
 * 触れない**。`packages/server/dist/main.js` は何ヶ月も前の時刻のままでありうる。
 * また web-ui のビルドは `typecheck && vite build` なので、ここが新しいことは
 * **その前段（ライブラリ / server）まで通った**ことも意味する。
 */
const STAMP = "packages/web-ui/dist/index.html";

/**
 * ソース側で見ないもの。`dist` と `node_modules` は成果物・依存、`.tsbuildinfo` は
 * ビルドのたびに書き換わる中間物なので、見ると**毎回「要ビルド」になる**。
 * `test` を外すのは、テストを直しても配信物が変わらないため。
 */
const SKIP = new Set(["node_modules", "dist", "test", "coverage"]);

/** ソース側の入口。`packages` の外にもビルドを変えるものがある（依存とコンパイラ設定） */
const ROOTS = ["packages", "package.json", "package-lock.json", "tsconfig.json"];

/** その配下でいちばん新しい更新時刻（ミリ秒） */
function newest(path) {
  const st = statSync(path);
  if (!st.isDirectory()) return st.mtimeMs;
  let t = 0;
  for (const e of readdirSync(path, { withFileTypes: true })) {
    if (SKIP.has(e.name) || e.name.endsWith(".tsbuildinfo")) continue;
    t = Math.max(t, newest(join(path, e.name)));
  }
  return t;
}

/**
 * **成果物がソースより古ければ作り直す。**
 *
 * 「`index.html` があるか」だけを見ていた頃は、`dist` が**あるけど古い**状態を素通りして
 * いた。ビルドが落ちた環境・`--build` を付けずに pull した環境では、それが常態になる。
 */
function needsBuild() {
  if (OUTPUTS.some((f) => !existsSync(f))) return true; // 未ビルド
  const src = Math.max(...ROOTS.filter((p) => existsSync(p)).map(newest));
  return src > statSync(STAMP).mtimeMs;
}

/**
 * **import しても走らない。** 判定（`satisfies`）を外から確かめられるようにするため、
 * 実行は「このファイルを直接叩いたとき」だけにする。
 */
const runDirectly = process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);

const mode = runDirectly ? process.argv[2] : "--noop";
if (mode === "--noop") {
  // import 経由。何もしない
} else if (mode === "--check-node") {
  const range = JSON.parse(readFileSync("package.json", "utf8")).engines?.node ?? "";
  if (range && !satisfies(process.versions.node, range)) {
    process.stderr.write(
      `Node.js のバージョンが古すぎます。\n` +
        `  必要: ${range}   (package.json の engines.node)\n` +
        `  現在: v${process.versions.node}\n` +
        `ビルドに使う vite / rolldown の要求です。満たさない Node ではビルドが途中で落ち、\n` +
        `古い dist が残ったまま起動して**古い画面が配信されます**。\n`
    );
    process.exit(1);
  }
} else if (mode === "--needs-build") {
  process.stdout.write(needsBuild() ? "1\n" : "0\n");
} else {
  process.stderr.write("usage: node launcher/preflight.mjs --check-node | --needs-build\n");
  process.exit(2);
}
