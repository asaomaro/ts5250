// **何も無い状態からサービスを立ち上げられるか**を実ブラウザで通す
// （`20260801-server-config-bootstrap` の受け入れ確認）。
//
// `.env` も `profiles.json` も無いところから、画面の操作だけで
//
//   システムを追加（保管場所: サーバー設定）
//     → プリンターセッションを追加（サービスとして使う ✅）
//       → サービスとして待ち受けが始まる
//
// までを通す。**途中で 1 か所でも詰まれば「できるようになった」とは言えない。**
//
// 実行: node --env-file=.env scripts/verify-fresh-service-setup.mjs
//   （`.env` は**実機の接続先を渡すため**だけに使う。サーバーは別の空ディレクトリで
//    起動するので、master key も設定ファイルもそちらには無い）
//
// 副作用: 既存の仮想プリンター装置を借りる（既定 PRT_TEST）。スプールは流さない。
// **装置は作らない・消さない。** 設定はテンポラリに作られ、終了時に消す。
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { chromium } from "playwright";

const host = process.env.AS400_HOST;
const user = process.env.AS400_USER;
const password = process.env.AS400_PASSWORD;
if (!host || !user || !password) {
  process.stderr.write("AS400_HOST / AS400_USER / AS400_PASSWORD を環境変数で渡してください\n");
  process.exit(2);
}
const PRTDEV = process.env.AS400_PRTDEV ?? "PRT_TEST";
const PORT = Number(process.env.PORT ?? 3493);
const REPO = new URL("..", import.meta.url).pathname;

const log = (s) => process.stdout.write(s + "\n");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0;
let fail = 0;
const check = (cond, msg) => {
  if (cond) { pass++; log(`  PASS ${msg}`); } else { fail++; log(`  FAIL ${msg}`); }
};
async function until(fn, ms = 40_000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (await fn()) return true;
    await sleep(400);
  }
  return false;
}

// **空のディレクトリで起動する。** `.env` も `profiles.json` も無い状態を作るため
const work = mkdtempSync(join(tmpdir(), "fresh-"));
log(`作業ディレクトリ: ${work}（.env も profiles.json も無い）`);

// `start.sh` と同じ引数で起動する（単一利用者向けのローカル起動）
const srv = spawn(
  process.execPath,
  [
    join(REPO, "packages/server/dist/main.js"),
    "--http",
    String(PORT),
    "--web-root",
    join(REPO, "packages/web-ui/dist"),
    "--auto-secret-key"
  ],
  { cwd: work, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, AS400_SECRET_KEY: "" } }
);
// サーバー側のログを溜める。**反映の失敗は握り潰される**（保存を巻き添えにしないため）ので、
// 立ち上がらなかったときはここを見ないと理由が分からない
const srvLog = [];
srv.stdout.on("data", (b) => srvLog.push(String(b)));
srv.stderr.on("data", (b) => srvLog.push(String(b)));
await sleep(2500);

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1400, height: 950 } });
const text = () => page.locator("body").innerText();
/**
 * 欄を**見出しの完全一致**で指す。
 *
 * - `hasText` の部分一致だと `title` に同じ語を含む別の欄にも当たる
 *   （「ホスト」が「ホストに印刷データへ変換させると…」に当たった）
 * - **正規表現は空白を正規化しない**ので、複数行に折り返した見出しには
 *   前後の改行が付く。`\s*` で挟まないと当たらない（実際に踏んだ）
 */
const field = (scope, cap) =>
  scope.locator(".row").filter({ has: page.locator(".cap", { hasText: new RegExp(`^\\s*${cap}\\s*$`) }) });

try {
  // ---- 0. 起動しただけで master key ができる ----
  log("\n### 0. 何も無い状態からの起動");
  check(existsSync(join(work, ".env")), "**`--auto-secret-key` で master key が作られる**");
  check(!existsSync(join(work, "profiles.json")), "この時点では profiles.json はまだ無い");
  const sys0 = await (await fetch(`http://127.0.0.1:${PORT}/api/systems`)).json();
  check(sys0.editable === true, "**ファイルが無くても編集できる**（今回の修正）");

  await page.goto(`http://127.0.0.1:${PORT}/`);
  await page.waitForSelector(".launcher", { timeout: 20_000 });

  // ---- 1. システムを「サーバー設定」で追加 ----
  log("\n### 1. システムを追加（保管場所: サーバー設定）");
  await page.locator("button.add", { hasText: "システムを追加" }).click();
  const card = page.locator(".card.editing").first();
  const place = field(card, "保管場所").locator("select");
  check((await place.count()) > 0, "**「保管場所」の選択欄が出る**（出ないのが今回の不具合だった）");
  await place.selectOption("server");
  await field(card, "名前").locator("input").fill("AS400");
  await field(card, "ホスト").locator("input").fill(host);
  await field(card, "既定 CCSID").locator("select").selectOption("5035");
  // **新規システムの既定は TLS 有効。** 実機は平文（23 番）なので外す
  // ——外し忘れると 992 番へ繋ぎに行って ECONNREFUSED になる
  const tls = field(card, "TLS").locator("input[type=checkbox]");
  if (await tls.isChecked()) await tls.uncheck();
  // 自動サインオン（サービスは人が居ないところで繋ぐので資格情報が要る）
  const autoSignon = field(card, "自動サインオン").locator("input[type=checkbox]");
  if (await autoSignon.count()) await autoSignon.check();
  await field(card, "ユーザー").locator("input").fill(user);
  await field(card, "パスワード").locator("input").fill(password);
  await card.locator(".editfoot button", { hasText: "保存" }).click();
  await sleep(1500);
  const errs = await page.locator(".card.editing .err").count();
  check(errs === 0, `保存が通る${errs ? " — " + (await page.locator(".card.editing .err").first().innerText()) : ""}`);
  check(existsSync(join(work, "profiles.json")), "**profiles.json が作られる**");
  const saved = JSON.parse(readFileSync(join(work, "profiles.json"), "utf8"));
  check(saved.systems?.[0]?.name === "AS400", "サーバー設定に入っている");
  check(
    typeof saved.systems?.[0]?.signon?.passwordEnc === "string" &&
      !JSON.stringify(saved).includes(password),
    "**パスワードは暗号化されて保存される**（平文が残らない）"
  );

  // ---- 2. プリンターセッションを追加（サービス ✅）----
  log("\n### 2. プリンターセッションを追加（サービスとして使う ✅）");
  // システムを選ぶ（保存後の一覧から）
  await page.reload();
  await page.waitForSelector(".launcher", { timeout: 20_000 });
  const pick = page.locator(".card", { hasText: "AS400" }).first().locator("button", { hasText: "選択" });
  if (await pick.count()) { await pick.click(); await sleep(500); }
  await page.locator("button.add", { hasText: "セッションを追加" }).click();
  const sc = page.locator(".card.editing").first();
  await field(sc, "名前").locator("input").fill("PRTSVC");
  await field(sc, "種類").locator("select").selectOption("printer");
  await field(sc, "装置名").locator("input").fill(PRTDEV);
  const svc = field(sc.locator(".trusted"), "サービスとして使う").locator("input[type=checkbox]");
  check((await svc.count()) > 0, "**「サービスとして使う」の欄が出る**（サーバー設定の子だから）");
  await svc.check();
  await sc.locator(".editfoot button", { hasText: "保存" }).click();
  await sleep(2000);
  const errs2 = await page.locator(".card.editing .err").count();
  check(errs2 === 0, `保存が通る${errs2 ? " — " + (await page.locator(".card.editing .err").first().innerText()) : ""}`);

  // ---- 3. 保存しただけでサービスが立ち上がる（#260）----
  log("\n### 3. サービスとして待ち受けが始まる");
  check(
    await until(async () => {
      const l = await (await fetch(`http://127.0.0.1:${PORT}/api/printers`)).json();
      return l.printers.some((p) => p.name === "PRTSVC" && p.state === "listening");
    }),
    "**保存しただけで待ち受けが始まる**（再起動しない）"
  );
  if (!(await (await fetch(`http://127.0.0.1:${PORT}/api/printers`)).json()).printers.some((p) => p.state === "listening")) {
    const lines = srvLog.join("").split("\n").filter((l) => /warn|error|reconcile|printer/i.test(l));
    log("  --- サーバーのログ ---\n" + lines.slice(-6).map((l) => "  | " + l.slice(0, 300)).join("\n"));
  }

  // ---- 4. サービス一覧に出る ----
  log("\n### 4. 画面で確認できる");
  await page.reload();
  await page.waitForSelector(".launcher", { timeout: 20_000 });
  const pick2 = page.locator(".card", { hasText: "AS400" }).first().locator("button", { hasText: "選択" });
  if (await pick2.count()) { await pick2.click(); await sleep(500); }
  await page.locator(".fn.app", { hasText: "サービス" }).locator("button").click();
  await page.waitForSelector(".services table", { timeout: 15_000 });
  const row = page.locator(".services tbody tr", { hasText: "PRTSVC" }).first();
  check((await row.innerText()).includes("待ち受け中"), "**サービス一覧に「待ち受け中」で出る**");
  check((await row.locator("button", { hasText: "停止" }).count()) > 0, "停止ボタンが出る");
  check(!(await text()).includes(password), "**画面にパスワードが出ない**");
} catch (e) {
  fail++;
  log(`  FAIL 例外: ${e?.message ?? e}`);
  try { log("  --- 画面 ---\n" + (await text()).split("\n").slice(0, 35).map((l) => "  | " + l).join("\n")); } catch { /* 良い */ }
} finally {
  await browser.close().catch(() => {});
  srv.kill("SIGTERM");
  await sleep(500);
  srv.kill("SIGKILL");
  try { rmSync(work, { recursive: true, force: true }); } catch { /* 良い */ }
}

log(`\n${fail === 0 ? "OK" : "NG"} — ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
