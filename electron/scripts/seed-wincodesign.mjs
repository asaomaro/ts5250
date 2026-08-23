// electron-builder の winCodeSign キャッシュを、Windows で展開できる形で用意する。
//
// **何が起きるか**: exe にアイコンとバージョン情報を焼く rcedit は、electron-builder が
// `winCodeSign` パッケージから取ってくる。ところがこの 7z には **macOS 用のシンボリック
// リンク**（darwin/10.12/lib/libcrypto.dylib ほか）が入っており、Windows でリンクを作るには
// 開発者モードか管理者権限が要る。無い環境では 7za が exit 2 を返し、4 回リトライして
// ビルドごと落ちる:
//
//     ERROR: Cannot create symbolic link : … \winCodeSign\…\darwin\10.12\lib\libcrypto.dylib
//
// **なぜ回避策を切り替えたか**: 以前は `win.signAndEditExecutable: false` で工程ごと外して
// いた（#202）。当時はアイコン未設定だったので失うものが無かったが、#294 でアイコンを
// 足したあともフラグが残っていたため、**インストールしたアプリのアイコンが Electron 既定の
// ままだった**。rcedit を通さずに exe へアイコンを埋める手段は無いので、工程を外すのを
// やめ、代わりに**壊れる原因（darwin のシンボリックリンク）だけを避けて展開**する。
// rcedit は Windows 版しか使わないので、darwin/ は丸ごと要らない。
//
// 署名はしていない（証明書未設定なら electron-builder が
// "no signing info identified, signing is skipped" で飛ばす）ので、
// ここで用意するのは実質 rcedit だけ。
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";

const log = (s) => process.stderr.write(`${s}\n`);

if (process.platform !== "win32") process.exit(0);

const require_ = createRequire(import.meta.url);
const path7za = require_("7zip-bin").path7za;
const appBuilderPath = require_("app-builder-bin").appBuilderPath;

const CACHE_ROOT =
  process.env.ELECTRON_BUILDER_CACHE || join(homedir(), "AppData", "Local", "electron-builder", "Cache");
const CACHE_DIR = join(CACHE_ROOT, "winCodeSign");

/** app-builder に「winCodeSign を用意しろ」と言う。成功すれば展開済みディレクトリのパスが返る。 */
function askAppBuilder() {
  try {
    const out = execFileSync(appBuilderPath, ["download-artifact", "--name", "winCodeSign"], {
      encoding: "utf8",
      env: { ...process.env, SZA_PATH: path7za },
      stdio: ["ignore", "pipe", "pipe"]
    });
    return { ok: true, path: out.trim() };
  } catch (err) {
    // stdout / stderr の両方に URL が出うる。バージョンはそこからしか分からない
    // （app-builder の中に埋め込まれていて、こちらから問い合わせる口が無い）
    return { ok: false, output: `${err.stdout ?? ""}${err.stderr ?? ""}` };
  }
}

const first = askAppBuilder();
if (first.ok) {
  log(`==> winCodeSign は用意済み: ${first.path}`);
  process.exit(0);
}

const version = /winCodeSign-(\d+\.\d+\.\d+)/.exec(first.output)?.[1];
if (version == null) {
  log("==> winCodeSign の展開に失敗しましたが、バージョンを特定できませんでした。そのまま続けます。");
  log(first.output.trim());
  process.exit(0);
}

// 失敗した試行が置いていった 7z を使い回す（無ければ諦めて electron-builder に任せる）
const archive = readdirSync(CACHE_DIR, { withFileTypes: true })
  .filter((e) => e.isFile() && e.name.endsWith(".7z"))
  .map((e) => join(CACHE_DIR, e.name))
  .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0];
if (archive == null) {
  log("==> winCodeSign のアーカイブが見つかりませんでした。そのまま続けます。");
  process.exit(0);
}

const dest = join(CACHE_DIR, `winCodeSign-${version}`);
log(`==> winCodeSign ${version} を darwin 抜きで展開する（シンボリックリンク回避）`);
mkdirSync(dest, { recursive: true });
try {
  execFileSync(path7za, ["x", archive, `-o${dest}`, "-x!darwin", "-bd", "-y"], { stdio: "ignore" });
} catch (err) {
  log(`==> 展開に失敗しました: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(0);
}

const second = askAppBuilder();
if (second.ok && existsSync(join(dest, "rcedit-x64.exe"))) {
  log(`==> 用意できました: ${second.path}`);
} else {
  log("==> まだ winCodeSign を用意できていません。ビルドはこのあと同じ理由で失敗するかもしれません。");
}
