// 実ブラウザ（web-ui）で実機に**結果を返さない SQL 文**を実行できるか検証する。
//
//   CREATE TABLE（DDL）→ INSERT → UPDATE → DELETE → MERGE → SELECT で中身を確認
//   → CREATE PROCEDURE / FUNCTION（複合文）→ CALL（出力パラメーター・結果セット）→ DROP
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
const LIB = process.env.AS400_LIB ?? "TESTLIB";
const T = "SQLEXECB";
/** 複合文（`BEGIN … END`）の検証で作る手続き・関数 */
const P = "SQLEXECP";
const F = "SQLEXECF";
/** 結果セットを返す手続き（`SQLCODE +466` の経路） */
const R = "SQLEXECR";

const results = [];
const check = (n, ok, d = "") => {
  results.push({ n, ok });
  process.stdout.write(`${ok ? "OK  " : "NG  "} ${n}${d ? ` — ${d}` : ""}\n`);
};

// 設定の置き場は差し替えられる（`SQLEXEC_TMP` と同じ扱い）。
// 個人の `connections.json` に実機を置いていない環境でも走らせるため
const cfg = JSON.parse(readFileSync(process.env.SQLEXEC_CONN ?? "connections.json", "utf8"));
const sys = cfg.systems.find((s) => s.name === (process.env.AS400_SYSTEM ?? "AS400"));
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
  // **システムが 1 つだけならアプリが自動で選ぶ**（選択画面が出ない）。
  // 出たときだけ押す——無条件に待つと、1 システムの環境では必ず時間切れになる
  const pick = page.locator(".card:has-text('実機') >> button:has-text('選択')");
  if ((await pick.count()) > 0) await pick.first().click();
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

  // --- MERGE（DML の 4 つ目。UPDATE と INSERT が 1 文に混ざる） ---
  const merged = await run(
    `MERGE INTO ${LIB}.${T} T USING (VALUES (3, 'm'), (4, 'n')) AS S(ID, S) ON T.ID = S.ID ` +
      `WHEN MATCHED THEN UPDATE SET T.S = S.S WHEN NOT MATCHED THEN INSERT (ID, S) VALUES (S.ID, S.S)`
  );
  check("**MERGE で 2 行に影響したと出る**", merged.includes("2 行に影響しました"), merged.slice(0, 200));

  // --- 複合文（`BEGIN … END`）。**本体の `;` で切らないこと**が要点 ---
  await run(`DROP PROCEDURE ${LIB}.${P}`);
  const proc = await run(
    [
      `CREATE PROCEDURE ${LIB}.${P} (IN P_ID INT, OUT P_S CHAR(10))`,
      "LANGUAGE SQL",
      "BEGIN",
      `  DECLARE C1 CURSOR FOR SELECT S FROM ${LIB}.${T} WHERE ID = P_ID;`,
      "  DECLARE CONTINUE HANDLER FOR SQLEXCEPTION SET P_S = 'ERR';",
      "  OPEN C1;",
      "  FETCH C1 INTO P_S;",
      "  CLOSE C1;",
      "  IF P_S IS NULL THEN",
      "    SET P_S = 'NONE';",
      "  END IF;",
      "END"
    ].join("\n")
  );
  check("**複合文の手続きが 1 文として通る**", proc.includes("実行しました"), proc.slice(0, 200));
  check("本体の `;` で切られていない（タブは 1 つ）", (await page.locator(".rtab").count()) <= 1);
  await shot("10-create-procedure");

  // --- CALL の出力パラメーター（`?`） ---
  const called = await run(`CALL ${LIB}.${P}(3, ?)`);
  check("**CALL が実行できる**", called.includes("実行しました"), called.slice(0, 200));
  const outs = await page.locator(".outparams tbody td").allInnerTexts();
  check("**出力パラメーターが値付きで出る**", outs[0] === "?1" && outs[1]?.trim() === "m", outs.join("|"));
  await shot("11-call-out");

  // --- 関数（複合文）と、その利用 ---
  await run(`DROP FUNCTION ${LIB}.${F}`);
  const fn = await run(
    [
      `CREATE FUNCTION ${LIB}.${F} (P_ID INT) RETURNS CHAR(10)`,
      "LANGUAGE SQL READS SQL DATA",
      "BEGIN",
      "  DECLARE V CHAR(10);",
      `  SET V = (SELECT S FROM ${LIB}.${T} WHERE ID = P_ID);`,
      "  RETURN CASE WHEN V IS NULL THEN 'NONE' ELSE V END;",
      "END"
    ].join("\n")
  );
  check("**複合文の関数が 1 文として通る**", fn.includes("実行しました"), fn.slice(0, 200));
  const used = await run(`SELECT ID, ${LIB}.${F}(ID) AS V FROM ${LIB}.${T} ORDER BY ID`);
  check("作った関数が SELECT から使える", used.includes("m") && used.includes("n"), used.slice(0, 300));
  await shot("12-function");

  // --- 結果セットを返す手続き（`SQLCODE +466`）---
  await run(`DROP PROCEDURE ${LIB}.${R}`);
  const rsProc = await run(
    [
      `CREATE PROCEDURE ${LIB}.${R} () LANGUAGE SQL DYNAMIC RESULT SETS 1`,
      "BEGIN",
      `  DECLARE C9 CURSOR WITH RETURN FOR SELECT ID, S FROM ${LIB}.${T} ORDER BY ID;`,
      "  OPEN C9;",
      "END"
    ].join("\n")
  );
  check("結果セットを返す手続きを作れる", rsProc.includes("実行しました"), rsProc.slice(0, 200));
  const rs = await run(`CALL ${LIB}.${R}()`);
  check("**結果セットを返す CALL が実行できる**", !rs.includes("SQLCODE=-"), rs.slice(0, 200));
  check("**結果セットがあることを言う**", rs.includes("結果セット"), rs.slice(0, 200));
  // 表に行が出ている（`m` / `n` は MERGE で入れた値）
  const rsRows = await page.locator(".rows-scroll tbody tr, table tbody tr").count();
  check("**結果セットが表で出る**", rsRows > 0 && rs.includes("m"), `rows=${rsRows}`);
  await shot("13-call-resultset");

  // --- 後片付け ---
  await run(`DROP PROCEDURE ${LIB}.${R}`);
  await run(`DROP FUNCTION ${LIB}.${F}`);
  const dp = await run(`DROP PROCEDURE ${LIB}.${P}`);
  check("**DROP PROCEDURE できる**", dp.includes("実行しました"), dp.slice(0, 200));
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
