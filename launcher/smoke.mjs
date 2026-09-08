// 起動確認（smoke）。**ビルドした成果物が「最初の使える状態」まで到達するかを見る。**
//
// 単体テストが全部緑でも、配線が壊れていて起動しないことは普通に起きる
// （`preflight.mjs` の冒頭に書いた「古い dist が配信され続けた」と同じ性質の事故）。
// ここで確かめるのは 3 つだけ:
//
//   1. サーバーが**実際に待ち受けを始める**か（`/healthz` が返るか）
//   2. **ビルド済みの Web UI が配信される**か（`/` が index.html を返すか）
//   3. 終了シグナルで**素直に終わる**か（掴んだ接続を残さない）
//
// **必ず終わるコマンドにしてある**（起動しっぱなしにしない）。CI と `aidev smoke` の
// 両方から同じものを叩けるように、判定はここ 1 か所に置く。
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
process.chdir(REPO);

const SERVER = "packages/server/dist/main.js";
const WEB_ROOT = "packages/web-ui/dist";
/** 待ち受けを待つ上限。遅い CI でも足りる程度に取る（`aidev smoke` 側の上限より十分短く） */
const READY_TIMEOUT_MS = 30_000;
/** 終了シグナルのあと、素直に終わるのを待つ上限 */
const EXIT_TIMEOUT_MS = 5_000;

const fail = (msg) => {
  console.error(`smoke: ${msg}`);
  process.exit(1);
};

for (const p of [SERVER, join(WEB_ROOT, "index.html")]) {
  if (!existsSync(p)) fail(`${p} がありません（先に npm run build / npm run build -w @ts5250/web-ui）`);
}

// **接続プロファイルは使い捨てにする。** リポジトリの profiles.local.json を触ると、
// 開発者の設定を smoke が書き換えることになる
const profiles = join(mkdtempSync(join(tmpdir(), "ts5250-smoke-")), "profiles.json");
writeFileSync(profiles, JSON.stringify({ systems: [], sessions: [] }));

/** 空いていそうな高位ポート。使用中なら次を試す（CI の並列実行で衝突しうる） */
const PORTS = [34971, 34972, 34973];

async function get(port, path) {
  const res = await fetch(`http://127.0.0.1:${port}${path}`);
  return { status: res.status, body: await res.text() };
}

async function waitReady(port, child) {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) return false; // 起動前に落ちた
    try {
      const r = await get(port, "/healthz");
      if (r.status === 200) return true;
    } catch {
      // まだ待ち受けていない
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
}

async function run(port) {
  const child = spawn(process.execPath, [SERVER, "--http", String(port), "--web-root", WEB_ROOT, "--profiles", profiles], {
    stdio: ["ignore", "inherit", "inherit"]
  });
  const stop = async () => {
    child.kill("SIGTERM");
    const gone = await Promise.race([
      new Promise((r) => child.once("exit", () => r(true))),
      new Promise((r) => setTimeout(() => r(false), EXIT_TIMEOUT_MS))
    ]);
    if (!gone) {
      child.kill("SIGKILL");
      fail("SIGTERM で終わりませんでした（掴んだ接続が残る）");
    }
  };
  if (!(await waitReady(port, child))) {
    await stop();
    return false;
  }
  const health = await get(port, "/healthz");
  const index = await get(port, "/");
  await stop();
  if (health.status !== 200) fail(`/healthz が ${health.status} を返しました`);
  // **画面まで配信されることを見る。** サーバーだけ起きていても、web-root の指定が
  // 外れていれば利用者には何も出ない（この 1 行が「最初の使える状態」の実体）
  if (index.status !== 200 || !index.body.includes("<div id=\"app\"")) {
    fail(`/ が Web UI を返しませんでした（status=${index.status}）`);
  }
  console.log(`smoke: /healthz ok, / が Web UI を返した (port ${port})`);
  console.log(`smoke: ${health.body}`);
  return true;
}

for (const port of PORTS) {
  if (await run(port)) process.exit(0);
  console.error(`smoke: port ${port} で起動できませんでした。次を試します`);
}
fail("どのポートでも起動できませんでした");
