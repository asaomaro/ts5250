// PR #231（IFS の上限表示・プレビュー競合・先回り判定）を実機で実測する。
//
// 確かめること:
//   L1  GET /api/host/ifs/limits が実効の上限 6 値を返す（接続不要）
//   L1b read の 413 に maxBytes が載る
//   L2  上限超過のファイルを画面から開くと、**read を発行せずに**断る（先回り）
//   L3  ヌルバイトを含むテキスト拡張子のファイルが「中身にバイナリ」と案内される
//   L4  zip の上限超過メッセージに**上限値**が出る
//   L5  プレビューの競合——連続で選ぶと**最後に選んだ方**が残る
//
// **クライアント側の振る舞いが本題**なので、API だけでなく実ブラウザで確かめる
// （L2 の「発行しない」は画面を通さないと意味が無い）。
// 画面操作の作法は `verify-browser-ifs.mjs` に合わせる（.card / .fn / .entries li / nav.crumbs）。
//
// 前提: npm run build && npm run build -w @ts5250/web-ui。`connections.json` に実機。
// 実行: node --env-file=.env scripts/verify-ifs-limits.mjs
import { readFileSync, mkdirSync, rmSync } from "node:fs";
import { serve } from "@hono/node-server";
import { WebSocketServer } from "ws";
import {
  buildApp,
  SessionManager,
  ServerConfigStore,
  PersonalConfigStore,
  ConfigResolver
} from "@ts5250/server";
import { SecretCrypto } from "../packages/server/dist/secret-crypto.js";
import { chromium } from "playwright";

const PORT = 3489;
const BASE = "/home/asao";
const DIR = `${BASE}/test`;
const TMP = "/tmp/as400-verify-ifs-limits";
const SHOTS = `${TMP}/shots`;
rmSync(TMP, { recursive: true, force: true });
mkdirSync(SHOTS, { recursive: true });

const log = (s) => process.stderr.write(`${s}\n`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok, detail });
  process.stdout.write(`${ok ? "OK  " : "NG  "} ${name}${detail ? ` — ${detail}` : ""}\n`);
};

// ---- サーバー（connections.json をそのまま使う。パスワードはスクリプトに書かない）----
const crypto = SecretCrypto.fromEnv();
const conn = JSON.parse(readFileSync("connections.json", "utf8"));
const sys = conn.systems.find((s) => s.name === (process.env.AS400_SYSTEM ?? "AS400"));
if (!sys) throw new Error("connections.json に実機がない");
const resolver = new ConfigResolver(
  new ServerConfigStore({ systems: [], sessions: [] }, crypto),
  PersonalConfigStore.fromFile("connections.json", crypto)
);
// **上限をわざと小さくする。** 既定 5MiB の超過を作るには 5MB 超を 100KB/s のホストへ
// 置く必要があり（約 1 分）、検証のたびに払うには高い。先回りの分岐は「sizeHint > 上限」で
// 決まるので、上限を下げれば**同じ経路**を通る（CLI 引数の反映も併せて確かめられる）
const READ_MAX = Number(process.env.IFS_READ_MAX ?? 4096);
const ZIP_MAX = 1024;
const app = buildApp({
  sessions: new SessionManager(),
  resolver,
  version: "verify-ifs-limits",
  webRoot: "packages/web-ui/dist",
  ifsReadMaxBytes: READ_MAX,
  ifsZipMaxBytes: ZIP_MAX
});
const wss = new WebSocketServer({ noServer: true });
const http = serve({ fetch: app.fetch, port: PORT, websocket: { server: wss } });
await sleep(600);

const source = { system: `own:${sys.id}` };
const api = async (route, body) => {
  const res = await fetch(`http://localhost:${PORT}/api/host/ifs/${route}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ source, ...body })
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
};

let browser;
try {
  // ---- L1: /limits ----------------------------------------------------------
  const lim = await fetch(`http://localhost:${PORT}/api/host/ifs/limits`);
  const limits = await lim.json();
  check(
    "L1 /limits が実効の上限 6 値を返す（接続不要・CLI 引数が反映される）",
    lim.status === 200 &&
      limits.readMaxBytes === READ_MAX &&
      limits.zipMaxBytes === ZIP_MAX &&
      limits.zipMaxFiles === 500 &&
      limits.zipMaxDirectories === 5000 &&
      limits.deleteMaxEntries === 1000 &&
      limits.deleteMaxDirectories === 500,
    JSON.stringify(limits)
  );

  // ---- 準備: ホストにテスト用のフォルダとファイルを置く ----------------------
  await api("delete", { path: DIR, recursive: true });
  const mk = await api("mkdir", { path: DIR });
  check(`準備 ${DIR} を作成`, mk.status === 200, `status=${mk.status}`);

  const smallBody = "hello from 実機\nにほんごの行\n";
  const w1 = await api("write", { path: `${DIR}/small.txt`, content: smallBody, encoding: "utf8", create: true });
  check("準備 small.txt", w1.status === 200, `status=${w1.status}`);

  const bigLen = READ_MAX + 512;
  const w2 = await api("write", {
    path: `${DIR}/big.txt`,
    content: "x".repeat(bigLen),
    encoding: "utf8",
    create: true
  });
  check(`準備 big.txt（${bigLen} バイト > 上限 ${READ_MAX}）`, w2.status === 200, `status=${w2.status}`);

  // 拡張子はテキストだが中身にヌルバイト
  const NUL = String.fromCharCode(0);
  const nulBuf = Buffer.from(`AB${NUL}CD${NUL}EF\n`, "utf8");
  const w3 = await api("write", {
    path: `${DIR}/binary.log`,
    content: nulBuf.toString("base64"),
    encoding: "base64",
    create: true
  });
  check("準備 binary.log（ヌルバイト入り）", w3.status === 200, `status=${w3.status}`);

  // ---- L1b / L4a: サーバーの 413 に上限が載る --------------------------------
  const r413 = await api("read", { path: `${DIR}/big.txt`, encoding: "utf8" });
  check(
    "L1b read の 413 に maxBytes が載る",
    r413.status === 413 && r413.body?.maxBytes === READ_MAX,
    `status=${r413.status} bytes=${r413.body?.bytes} maxBytes=${r413.body?.maxBytes}`
  );
  const z = await api("zip", { path: DIR });
  check(
    "L4a zip の 413 に maxFiles / maxBytes が載る",
    z.status === 413 && z.body?.maxBytes === ZIP_MAX && z.body?.maxFiles === 500,
    `status=${z.status} max=${z.body?.maxFiles}/${z.body?.maxBytes}`
  );

  // ---- ブラウザ --------------------------------------------------------------
  browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1600, height: 900 }, acceptDownloads: true });
  page.on("pageerror", (e) => log(`PAGEERR ${e.message}`));
  page.on("console", (m) => {
    if (m.type() === "error") log(`[console] ${m.text()}`);
  });
  page.on("dialog", (d) => d.accept());

  /** 画面が発行した read の path を記録する（**先回りの検証はこれが本体**） */
  const reads = [];
  page.on("request", (req) => {
    if (req.url().endsWith("/api/host/ifs/read")) {
      reads.push(JSON.parse(req.postData() ?? "{}").path ?? "?");
    }
  });

  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const row = (name) =>
    page
      .locator(".entries li")
      .filter({ has: page.locator(".name").filter({ hasText: new RegExp(`^${esc(name)}$`) }) })
      .first();
  const previewText = async () =>
    (await page.locator(".preview").count()) === 0
      ? ""
      : ((await page.locator(".preview").first().innerText()) ?? "").replace(/\s+/g, " ").trim();
  const shot = async (n) => await page.screenshot({ path: `${SHOTS}/${n}.png` }).catch(() => {});
  /**
   * プレビューの見出しが目的のファイルに変わるまで待つ。
   * **固定待ちにしない**——実機は 1 往復が数秒かかり（書き込みで 4〜8 秒を実測）、
   * sleep で待つと「まだ来ていない」を「壊れている」と読み違える。
   */
  const awaitPreview = async (name) => {
    await page
      .waitForFunction(
        (n) => document.querySelector(".preview .path")?.textContent?.endsWith(n) ?? false,
        name,
        { timeout: 120000 }
      )
      .catch(() => {});
    // 見出しが変わった後、本文・案内の描画が 1 tick 遅れることがある
    await sleep(300);
  };

  await page.goto(`http://localhost:${PORT}/`);
  await page.locator(".card", { hasText: (process.env.AS400_SYSTEM ?? "AS400") }).first().waitFor({ timeout: 30000 });
  await page.locator(".card", { hasText: (process.env.AS400_SYSTEM ?? "AS400") }).first().locator("button", { hasText: "選択" }).click();
  await page.locator(".fn", { hasText: "IFS" }).first().locator("button").first().click();
  await page.waitForSelector(".ifs", { timeout: 30000 });
  await page.locator(".entries li").first().waitFor({ timeout: 60000 });

  // BASE/test まで辿る。
  // **画面に出るのは格納されている綴り。** IFS は解決時に大小を区別しないので
  // API は小文字でも通るが、一覧の行を掴むには綴りを合わせる必要がある
  for (const [step, expect] of [
    ["home", LEAF],
    [LEAF, "test"],
    ["test", "small.txt"]
  ]) {
    await row(step).click();
    await row(expect).waitFor({ timeout: 60000 });
  }
  const crumbs = (await page.locator("nav.crumbs button").allTextContents()).join("/");
  check(`準備 ${DIR} まで辿れる`, new RegExp(LEAF, "i").test(crumbs) && crumbs.includes("test"), crumbs);
  await shot("01-dir");

  // ---- L2: 先回り ------------------------------------------------------------
  reads.length = 0;
  await row("small.txt").click();
  await page.locator(".preview .editor").waitFor({ timeout: 60000 }).catch(() => {});
  const readSmall = reads.filter((p) => p.endsWith("small.txt")).length;
  await shot("02-small");

  await row("big.txt").click();
  await awaitPreview("big.txt");
  // **先回りが効いていれば即座に表示が変わる。** 効いていなければ read が飛ぶので、
  // 見出しが変わった後にも猶予を取って「後から飛んでいない」ことまで見る
  await sleep(3000);
  const readBig = reads.filter((p) => p.endsWith("big.txt")).length;
  const bigText = await previewText();
  await shot("03-toolarge");

  check("L2a 小さいファイルは従来どおり読む", readSmall === 1, `read(small)=${readSmall}`);
  check(
    "L2b 上限超過は read を発行せずに断る",
    readBig === 0 && bigText.includes("大きすぎる"),
    `read(big)=${readBig} / ${bigText.slice(0, 100)}`
  );
  check(
    "L2c 断り文に実測値と上限の両方が出る",
    // **単位を決め打ちしない。** 上限を下げて検証するので KB / B で出るのが正しい
    /大きすぎる.*[\d.]+ (B|KB|MB).*上限.*[\d.]+ (B|KB|MB)/.test(bigText) &&
      !bigText.includes("0.0 MB"),
    bigText.slice(0, 120)
  );
  check(
    "L2d 空の編集欄・空の iframe を出さない",
    (await page.locator(".preview .editor").count()) === 0 &&
      (await page.locator(".preview iframe").count()) === 0
  );

  // ---- L3: ヌルバイト --------------------------------------------------------
  await row("binary.log").click();
  await awaitPreview("binary.log");
  const nulText = await previewText();
  await shot("04-binary");
  check(
    "L3 ヌルバイト入りは「中身にバイナリ」と案内する",
    nulText.includes("バイナリ"),
    nulText.slice(0, 120)
  );

  // ---- L5: 競合 --------------------------------------------------------------
  // 大きい方（読みに行く）を選んだ直後に小さい方へ切り替える。**最後に選んだ方**が残ること
  reads.length = 0;
  await row("binary.log").click();
  await row("small.txt").click();
  await awaitPreview("small.txt");
  // 捨てられた方が後から勝たないことまで見る（実機の往復ぶん待つ）
  await sleep(5000);
  const raceText = await previewText();
  // **本文は textarea の value。** innerText には出ないので、そこだけ別に取る
  const raceBody =
    (await page.locator(".preview .editor").count()) > 0
      ? await page.locator(".preview .editor").first().inputValue()
      : "";
  await shot("05-race");
  check(
    "L5 連続で選んでも最後に選んだ方が残る",
    raceText.includes("/test/small.txt") && raceBody.includes("hello from 実機"),
    `見出し=${raceText.slice(0, 60)} / 本文=${raceBody.replace(/\s+/g, " ").slice(0, 60)}`
  );

  // ---- L4b: zip の文言 -------------------------------------------------------
  // 1 つ上へ戻り、test フォルダを選んでから「まとめてダウンロード」
  await page.locator("nav.crumbs button", { hasText: /^USER$/i }).first().click();
  await row("test").waitFor({ timeout: 60000 });
  await row("test").click();
  await page.locator(".entries li").first().waitFor({ timeout: 60000 });
  const zipBtn = page.locator("header button", { hasText: "まとめて" }).first();
  if ((await zipBtn.count()) > 0) {
    await zipBtn.click();
    await page
      .waitForFunction(() => (document.querySelectorAll("p.error").length ?? 0) > 0, undefined, {
        timeout: 120000
      })
      .catch(() => {});
    await sleep(500);
    const err =
      (await page.locator("p.error").count()) > 0
        ? ((await page.locator("p.error").first().textContent()) ?? "").trim()
        : "";
    await shot("06-zip");
    check("L4b zip の上限超過メッセージに上限値が出る", err.includes("上限"), err.slice(0, 140));
  } else {
    check("L4b zip ボタンが見つからない（検証できず）", false, "header の「まとめて」が無い");
  }
} finally {
  await browser?.close();
  http.close();
  wss.close();
}

const ng = results.filter((r) => !r.ok);
process.stdout.write(`\nRESULT: pass=${results.length - ng.length} fail=${ng.length}\n`);
process.stdout.write(`shots: ${SHOTS}\n`);
if (ng.length > 0) process.exitCode = 1;
