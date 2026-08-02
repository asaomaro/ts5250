// 実ブラウザ（web-ui）で実機に**結果を返さない SQL 文**を実行できるか検証する。
//
//   CREATE TABLE（DDL）→ INSERT → UPDATE → DELETE → SELECT で中身を確認 → DROP
//
// **「実際にホストの表が変わったか」はここでしか確かめられない。** 単体テストは偽の接続で
// 要求の形と SQLCODE の扱いを固定しているだけで、書けたかどうかは実機に聞くほかない。
// 併せて画面の見え方（「N 行に影響しました」/「実行しました」/ 警告）も撮る。
//
// 前提: npm run build 済み。`connections.json` に実機。
// 実行: AS400_PASSWORD=... node scripts/verify-browser-sql-exec.mjs
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { serve } from "@hono/node-server";
import { WebSocketServer } from "ws";
import {
  buildApp,
  SessionManager,
  ServerConfigStore,
  PersonalConfigStore,
  ConfigResolver
} from "@ts5250/server";
import { chromium } from "playwright";

const log = (s) => process.stderr.write(s + "\n");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const PORT = 3487;
const TMP = process.env.SQLEXEC_TMP ?? "/tmp/as400-verify-sql-exec";
const SHOTS = `${TMP}/shots`;
mkdirSync(SHOTS, { recursive: true });

/** 後片付けが要らない QTEMP ではなく**実ライブラリー**で試す（警告 7905 の経路も見る） */
const LIB = "TESTLIB";
const T = "SQLEXECB";

const results = [];
const check = (n, ok, d = "") => {
  results.push({ n, ok });
  process.stdout.write(`${ok ? "OK  " : "NG  "} ${n}${d ? ` — ${d}` : ""}\n`);
};

const cfg = JSON.parse(readFileSync("connections.json", "utf8"));
const sys = cfg.systems.find((s) => s.name === "実機");
if (!process.env.AS400_PASSWORD) {
  log("AS400_PASSWORD が未設定です");
  process.exit(1);
}
// **資格情報は `passwordEnv` で渡す**（この環境では `SecretCrypto.fromEnv()` が使えず
// `passwordEnc` を復号できない）。**書くのは環境変数の名前だけ**——値はファイルに落とさない。
sys.signon = { user: sys.signon.user, passwordEnv: "AS400_PASSWORD" };
mkdirSync(TMP, { recursive: true });
const tmpCfg = `${TMP}/conn-sql-exec.json`;
writeFileSync(tmpCfg, JSON.stringify(cfg));

const resolver = new ConfigResolver(
  ServerConfigStore.fromFile(tmpCfg),
  new PersonalConfigStore({ systems: [], sessions: [] })
);
const app = buildApp({
  sessions: new SessionManager(),
  resolver,
  version: "verify",
  webRoot: "packages/web-ui/dist"
});
const wss = new WebSocketServer({ noServer: true });
const server = serve({ fetch: app.fetch, port: PORT, websocket: { server: wss } });
await sleep(600);

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1500, height: 900 } });
page.on("pageerror", (e) => log("PAGEERR " + e.message));
const shot = async (name) => {
  await page.screenshot({ path: `${SHOTS}/${name}.png` });
  log(`shot: ${SHOTS}/${name}.png`);
};

/** SQL 欄へ入れて実行し、結果領域の文字列を返す */
async function run(sql) {
  const box = page.locator(".sql-pane textarea");
  await box.fill(sql);
  await page.click(".sql-pane header button:has-text('実行')");
  // **完了を待つ**（接続の張り直しで 6 秒近くかかることがある）
  await page
    .waitForFunction(
      () => {
        const p = document.querySelector(".sql-pane .done, .sql-pane .error, .sql-pane table");
        return p !== null;
      },
      { timeout: 40000 }
    )
    .catch(() => undefined);
  await sleep(400);
  return await page.locator(".sql-pane").innerText();
}

try {
  await page.goto(`http://localhost:${PORT}/`);
  await page.waitForSelector(".launcher", { timeout: 20000 });
  await page.click(".card:has-text('実機') >> button:has-text('選択')");
  await page.waitForSelector(".fn:has-text('SQL')", { timeout: 10000 });
  await page.click(".fn:has-text('SQL') >> button");
  await page.waitForSelector(".sql-pane textarea", { timeout: 15000 });
  await shot("01-open");

  // 前回の残りを消す（失敗してよい）
  await run(`DROP TABLE ${LIB}.${T}`);

  // --- DDL: 作れるか ---
  const created = await run(`CREATE TABLE ${LIB}.${T} (ID INT, S CHAR(10))`);
  check("**DDL が実行でき、完了が出る**", created.includes("実行しました"), created.slice(0, 200));
  check(
    "行数の意味が無い文に「0 行に影響しました」と出さない",
    !created.includes("0 行に影響しました")
  );
  // 実ライブラリーへの CREATE は警告つき成功で返ることがある（research F6 の 7905）
  log(`CREATE の表示: ${created.includes("SQLCODE") ? "警告つき" : "警告なし"}`);
  await shot("02-create");

  // --- DML: 行数が出るか ---
  const ins = await run(`INSERT INTO ${LIB}.${T} VALUES(1, 'a')`);
  check("**INSERT で 1 行に影響したと出る**", ins.includes("1 行に影響しました"), ins.slice(0, 200));
  await shot("03-insert");

  await run(`INSERT INTO ${LIB}.${T} VALUES(2, 'b')`);
  const upd = await run(`UPDATE ${LIB}.${T} SET S = 'z'`);
  check("**UPDATE で 2 行に影響したと出る**", upd.includes("2 行に影響しました"), upd.slice(0, 200));
  await shot("04-update");

  const del = await run(`DELETE FROM ${LIB}.${T} WHERE ID = 1`);
  check("**DELETE で 1 行に影響したと出る**", del.includes("1 行に影響しました"), del.slice(0, 200));

  // --- 実際にホストの表が変わったか（SELECT で確認） ---
  const sel = await run(`SELECT ID, S FROM ${LIB}.${T} ORDER BY ID`);
  check("**書き込みが実際に効いている**（残るのは ID=2 / S=z）", sel.includes("2") && sel.includes("z"), sel.slice(0, 300));
  check("SELECT は表で出る（実行結果の文言は出さない）", !sel.includes("実行しました"));
  await shot("05-select");

  // --- 失敗が理由付きで出るか ---
  const bad = await run(`DELETE FROM ${LIB}.NOSUCHTBL`);
  check("**存在しない表は SQLCODE 付きで失敗する**", bad.includes("SQLCODE"), bad.slice(0, 200));
  await shot("06-error");

  // --- マーカー付きは断るか ---
  const marker = await run(`DELETE FROM ${LIB}.${T} WHERE ID = ?`);
  check(
    "**パラメータマーカー付きは実行前に断る**",
    marker.includes("パラメータマーカー"),
    marker.slice(0, 200)
  );

  // --- `;` 区切りで混在させたとき ---
  const mixed = await run(
    `INSERT INTO ${LIB}.${T} VALUES(3, 'c'); SELECT ID, S FROM ${LIB}.${T} ORDER BY ID`
  );
  check("**混在させるとタブが 2 つ出る**", (await page.locator(".rtab").count()) === 2, mixed.slice(0, 200));
  check("1 番目（非クエリ）の結果が出ている", mixed.includes("1 行に影響しました"));
  await shot("07-mixed");
  // 2 番目のタブ（SELECT）へ切り替えると表になる
  await page.locator(".rtab").nth(1).click();
  await sleep(500);
  const second = await page.locator(".sql-pane").innerText();
  check("2 番目のタブは表（追加した行が見える）", second.includes("3") && second.includes("c"));
  await shot("08-mixed-2");

  // --- 後片付け ---
  const dropped = await run(`DROP TABLE ${LIB}.${T}`);
  check("**DROP できる**（後片付け）", dropped.includes("実行しました"), dropped.slice(0, 200));
  await shot("09-drop");
} catch (e) {
  check("例外なく完走", false, e.message);
  log(e.stack ?? "");
} finally {
  await browser.close();
  server.close();
  wss.close();
}

const failed = results.filter((r) => !r.ok);
process.stdout.write(`\n${results.length - failed.length}/${results.length} passed\n`);
process.exit(failed.length === 0 ? 0 : 1);
