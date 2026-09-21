// **ACS のコア（HACL/ECL）を GUI 無しで実機に当て、ACS 側の画面・カーソル・入力禁止の状態を出す。**
//
// 当 PJ の挙動を「ACS と同じか」で確かめるとき、これまでは利用者に ACS を起動してもらうか、
// `tap-proxy.mjs` を挟んで操作してもらう必要があった。ACS の jar に入っている HACL
// （`com.ibm.eNetwork.ECL.ECLSession` / `ECLPS` / `ECLOIA`）を自作の Java から呼べば、
// ACS のデータストリーム処理そのものを手順どおりに動かせる（`20260919-backlog-acs-triage` research F0-2）。
// 取れるのは**コアの挙動だけ**で、GUI 固有の経路は取れない。
//
// 実行:
//   node --env-file=.env --env-file=.env.verify scripts/acs-probe.mjs <手順ファイル> [AS400|PUB400]
//   例: node --env-file=.env --env-file=.env.verify scripts/acs-probe.mjs scripts/acs-probe/attn-restore.txt
//
// 環境変数:
//   <接頭辞>_USER / _PASSWORD（`.env`）  <接頭辞>_HOST（`.env`。PUB400 だけ既定 pub400.com）
//   <接頭辞>_LIB（`.env.verify`。手順の `${LIB}`）
//   ACS_JAR（既定: リポジトリ直下の `IBMiAccess_v1r1/acsbundle.jar`。`.gitignore` 済み）
//   PROBE_CODEPAGE（既定: AS400 は 930 / PUB400 は 37） / PROBE_SCREEN（24x80 既定 / 27x132）
//   PROBE_DEVNAME（既定は指定しない） / PROBE_PORT（既定 23）
//   PROBE_AUTORECONNECT（既定は指定しない。`true` で自動再接続を有効化——ACS の GUI の既定に寄せて測るとき）
//   PROBE_ENPTUI（既定は指定しない。`true` で拡張 5250 を申告——利用者の ACS と同じ。継続欄（EDTMSK）を測るとき）
//   PROBE_BYPASS_SIGNON（既定は指定しない。`clear` / `encrypted` で ACS の自動サインオン——NEW-ENVIRON を `tap-proxy.mjs` で採るとき）
//   PROBE_CODEPAGE_KEY（既定は指定しない。GUI の ACS が入れる `codePageKey`。KBDTYPE がこれで決まる。例 1399 は KEY_JAPAN_ENGLISH_EX_EURO）
//   PROBE_PASSWORD_LEVEL（既定は指定しない。`PROBE_BYPASS_SIGNON=encrypted` の代替パスワードの計算に使う QPWDLVL。製品の ACS はサインオン・サーバーに聞く）
//
// 手順ファイルの文法（1 行 1 命令。`#` はコメント）は `scripts/README.md`「ACS のコアを直接動かす」。
//
// **ACS の jar はリポジトリに入れない**（IBM の頒布物。AGENTS.md「ライセンスと出典」）。
// 取り出した `acshod2.jar` と、コンパイルした class は**利用者ごとの**キャッシュ（`~/.cache/ts5250-acs-probe`）にだけ置く。
// 前提: JDK 17 以上（`jar` と `javac`。JRE だけでは動かない）。副作用: 実機へ表示セッションを 1 本張る
// （装置名はホストに採らせる）。手順の最後で SIGNOFF すること。オブジェクトは作らない。
//
// 終了コード（**0 は手順を最後まで流したときだけ**）:
//   0 = 最後まで流した / 1 = JVM を起動できない / 2 = 実行前の誤り（環境変数・JDK・jar・コンパイル・手順）/
//   3 = 接続できない・サインオンできない / 4 = 途中で止まった（例外・エラー）/ 5 = 時間切れ（300 秒）
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const out = (s) => process.stdout.write(s + "\n");
const fail = (s) => {
  process.stderr.write(s + "\n");
  process.exit(2);
};

const [stepsArg, prefixArg] = process.argv.slice(2);
if (!stepsArg) fail("使い方: node --env-file=.env --env-file=.env.verify scripts/acs-probe.mjs <手順ファイル> [AS400|PUB400]");
const prefix = prefixArg ?? "AS400";
// PUB400 のホストは公開の既定がある（`scripts/README.md`「実行方法」と同じ扱い）
const host = process.env[`${prefix}_HOST`] ?? (prefix === "PUB400" ? "pub400.com" : undefined);
if (!host || !process.env[`${prefix}_USER`] || !process.env[`${prefix}_PASSWORD`]) {
  fail(`${prefix}_USER / ${prefix}_PASSWORD（と ${prefix}_HOST）が要ります（.env）`);
}
const steps = resolve(stepsArg);
if (!existsSync(steps)) fail(`手順ファイルがありません: ${steps}`);

const acsJar = resolve(process.env.ACS_JAR ?? join(REPO, "IBMiAccess_v1r1/acsbundle.jar"));
if (!existsSync(acsJar)) fail(`ACS の jar がありません: ${acsJar}（ACS_JAR で指定できます）`);
for (const tool of ["jar", "javac", "java"]) {
  const r = spawnSync(tool, ["--version"], { encoding: "utf8" });
  if (r.error) fail(`${tool} が見つかりません（JDK 17 以上が要ります）`);
}

// ---- 作業ディレクトリ: 利用者ごと・本人しか書けない場所 ----
// 共有の一時ディレクトリに固定名で置くと、他の利用者が先に作った class を、資格情報を持つ JVM で
// 動かしうる（`20260919-backlog-acs-triage` review ラウンド 1）。所有者も確かめる
const work = join(homedir(), ".cache", "ts5250-acs-probe");
mkdirSync(work, { recursive: true, mode: 0o700 });
if (typeof process.getuid === "function" && statSync(work).uid !== process.getuid()) {
  fail(`作業ディレクトリの所有者が自分ではありません: ${work}`);
}

// ---- acshod2.jar を取り出す ----
// 取り出したファイルの時刻は jar の中の日付になり、元の jar と比べられない。
// 元の jar のパス・大きさ・時刻を印に残し、変わったときだけ取り出し直す
const hod = join(work, "plugins", "emulator", "acshod2.jar");
const stamp = join(work, "acshod2.source");
const st = statSync(acsJar);
const want = `${acsJar}:${st.size}:${st.mtimeMs}`;
const have = existsSync(stamp) ? readFileSync(stamp, "utf8") : "";
if (!existsSync(hod) || have !== want) {
  // **先に消す**——`jar xf` は指定した項目が jar に無くても exit 0 を返すので、
  // 残っていた古い acshod2.jar を新しい印のまま使い続けてしまう
  rmSync(hod, { force: true });
  const r = spawnSync("jar", ["xf", acsJar, "plugins/emulator/acshod2.jar"], { cwd: work, encoding: "utf8" });
  if (r.status !== 0 || !existsSync(hod)) fail(`acshod2.jar を取り出せませんでした（jar の中の位置が変わった可能性）: ${r.stderr ?? ""}`);
  writeFileSync(stamp, want);
}

// ---- AcsProbe.java をコンパイルする（ソースの方が新しいときと、jar を取り出し直したとき）----
const src = join(REPO, "scripts", "acs-probe", "AcsProbe.java");
const cls = join(work, "AcsProbe.class");
if (!existsSync(cls) || statSync(cls).mtimeMs < statSync(src).mtimeMs || have !== want) {
  const r = spawnSync("javac", ["-encoding", "UTF-8", "-d", work, "-cp", hod, src], { encoding: "utf8" });
  if (r.status !== 0) fail(`AcsProbe.java をコンパイルできませんでした（JDK 17 以上が要ります）:\n${r.stderr}`);
}

// ---- 実行 ----
const screenCode = { "24x80": "2", "27x132": "5" }[process.env.PROBE_SCREEN ?? "24x80"];
if (!screenCode) fail(`PROBE_SCREEN は 24x80 か 27x132 です（${process.env.PROBE_SCREEN}）`);
// **JVM へ渡す環境変数は要るものだけ**——`.env` の他の秘密（master key・もう一方の接頭辞のパスワード）を
// HACL 側へ持ち込まない
const pick = (...names) => Object.fromEntries(names.filter((n) => process.env[n] !== undefined).map((n) => [n, process.env[n]]));
const env = {
  // ロケールは LANG だけでなく LC_ALL / LC_CTYPE でも決まる。落とすと JVM が POSIX になり、ASCII でない
  // パス（手順ファイル・ホームのキャッシュ）が読めなくなる（`20260919-backlog-acs-triage` review ラウンド 2）
  ...pick("PATH", "JAVA_HOME", "HOME", "USERPROFILE", "SystemRoot", "TEMP", "TMP", "TMPDIR", "LANG", "LC_ALL", "LC_CTYPE"),
  ...pick(`${prefix}_USER`, `${prefix}_PASSWORD`, `${prefix}_LIB`, "PROBE_PORT", "PROBE_DEVNAME", "PROBE_AUTORECONNECT", "PROBE_ENPTUI", "PROBE_BYPASS_SIGNON", "PROBE_CODEPAGE_KEY", "PROBE_PASSWORD_LEVEL"),
  [`${prefix}_HOST`]: host,
  // 930 の SBCS（290）には英小文字が無い。大文字小文字を区別する PUB400（QPWDLVL 3）では 37 を既定にする
  PROBE_CODEPAGE: process.env.PROBE_CODEPAGE ?? (prefix === "PUB400" ? "37" : "930"),
  PROBE_SCREEN_CODE: screenCode
};
const r = spawnSync(
  "java",
  ["-Djava.awt.headless=true", "-cp", `${hod}${delimiter}${work}`, "AcsProbe", steps, prefix],
  // **資格情報は環境変数で渡す**——引数に載せると ps で見える
  { env, encoding: "utf8", timeout: 300_000 }
);
// 出力から `.env` の値（パスワード・ホスト・利用者名）を伏せる。HACL の例外や画面（WRKACTJOB 等）に載ることがある
// **大文字小文字を問わずに伏せる**——IBM i は利用者名を大文字で表示するので、`.env` が小文字だと素通りする
const secrets = [process.env[`${prefix}_PASSWORD`], host, process.env[`${prefix}_USER`]].filter((v) => v && v.length >= 3);
const escapeRe = (v) => v.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const scrub = (t) => secrets.reduce((a, v) => a.replace(new RegExp(escapeRe(v), "gi"), "***"), t ?? "");
// HACL が起動時に出す版数の 3 行は捨てる（毎回同じで、結果の読み取りの邪魔になる）
const banner = /^(IBM Host Access Class Library|Version:|Copyright IBM)/;
scrub(r.stdout)
  .split("\n")
  .filter((l) => l !== "" && !banner.test(l))
  .forEach(out);
if (r.stderr) process.stderr.write(scrub(r.stderr));
// 時間切れは手順の誤り（2）と分ける。HACL が固まったのか、手順が悪いのかで打つ手が違う
if (r.error?.code === "ETIMEDOUT") {
  process.stderr.write("時間切れ（300 秒）。HACL が応答しないまま止まった可能性があります\n");
  process.exit(5);
}
if (r.error) {
  process.stderr.write(`java を起動できませんでした: ${r.error.message}\n`);
  process.exit(1);
}
// java が自分で落ちた（クラスが見つからない等）ときは 1 を返す。AcsProbe の終了コードはそのまま通す
process.exit(r.status ?? 1);
