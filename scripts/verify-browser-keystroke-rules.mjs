// **入力欄の型ごとの打鍵規則**を実機で確かめる（AUDPGM の画面）。
//
// 見るのは「打てるか」ではなく **打った通りにホストへ届くか**。AUDPGM は受け取った値を
// そのまま画面へ返すので、画面の入力欄と「HOST RECEIVED」の欄を突き合わせれば分かる。
//
//   ① 数字専用（DDS 35 桁の `D`）に `.` が打てない（打てると送信時に `FIELD_TYPE` で
//      1 バイトも飛ばず、画面は何も変わらない＝「Enter が効かない」に見える）
//   ② 数字専用での `-` が Field− に化けない（化けると打った桁が消えて次欄へ飛ぶ）
//   ③ 符号付き数値（`6S 0`＝ワイヤ長 7）の符号桁に数字が入らない
//      （入ると画面は `1234567` なのにホストは `123456` を受け取る）
//   ④ 送信が拒否されたら**理由が画面に出る**（黙って無反応にしない）
//
// 検証資材は scripts/build-audpgm.mjs が作る <LIB>/AUDDSPF ＋ AUDPGM。
//
// 実行:
//   npm run build && npm run build -w @ts5250/web-ui
//   node --env-file=.env --env-file=.env.verify scripts/verify-browser-keystroke-rules.mjs
// 任意: SHOT_OUT（画像の出力先。既定 /tmp）/ VERIFY_DEBUG=1（画面テキストを出す）
//
// 副作用: 実機へ表示セッションを 1 本張り、テスト画面を呼ぶだけ。**装置名は指定せず
// ホストに採らせる**（共有機なので既存の装置名を奪わない）。オブジェクトは作らない。
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serve } from "@hono/node-server";
import { WebSocketServer } from "ws";
import { buildApp, SessionManager, ServerConfigStore, PersonalConfigStore, ConfigResolver } from "@ts5250/server";
import { SecretCrypto } from "../packages/server/dist/secret-crypto.js";
import { chromium } from "playwright";

const host = process.env.AS400_HOST;
const user = process.env.AS400_USER;
if (!host || !user || !process.env.AS400_PASSWORD) {
  process.stderr.write("AS400_HOST / AS400_USER / AS400_PASSWORD を環境変数で渡してください\n");
  process.exit(2);
}
const LIB = process.env.AS400_LIB ?? "TESTLIB";
const OUT = process.env.SHOT_OUT ?? tmpdir();
const PORT = Number(process.env.PORT ?? 3497);

// AUDDSPF の位置（build-audpgm.mjs と揃える）
const DGT = { row: 5, col: 30 };
const SGN = { row: 7, col: 30 };
const ECHO_DGT_ROW = 16;
const ECHO_SGN_ROW = 18;

const log = (s) => process.stdout.write(s + "\n");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
const check = (cond, msg) => { if (cond) { pass++; log(`  PASS ${msg}`); } else { fail++; log(`  FAIL ${msg}`); } };

const work = mkdtempSync(join(tmpdir(), "keyrules-"));
const cfgPath = join(work, "profiles.json");
// **パスワードはファイルに書かない**——`passwordEnv` で環境変数を指す
writeFileSync(
  cfgPath,
  JSON.stringify({
    systems: [{ id: "AS400", name: "AS400", host, ccsid: 930, signon: { user, passwordEnv: "AS400_PASSWORD" } }],
    sessions: [{ id: "DSP", name: "DSP", system: "AS400", sessionType: "display", screenSize: "24x80" }]
  })
);

const crypto = SecretCrypto.fromEnv();
const resolver = new ConfigResolver(
  ServerConfigStore.fromFile(cfgPath, crypto),
  new PersonalConfigStore({ systems: [], sessions: [] }, crypto)
);
const app = buildApp({ sessions: new SessionManager(), resolver, version: "verify", webRoot: "packages/web-ui/dist" });
const wss = new WebSocketServer({ noServer: true });
const server = serve({ fetch: app.fetch, port: PORT, websocket: { server: wss } });
await sleep(600);

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 }, deviceScaleFactor: 2 });
await ctx.grantPermissions(["clipboard-read", "clipboard-write"], { origin: `http://localhost:${PORT}` });
const page = await ctx.newPage();

const fieldSel = (p) => `input.grid-input[data-field="f${p.row}c${p.col}"]`;
/** 欄へカーソルを置いて先頭から打つ（既存値は上書き） */
async function typeAt(p, text) {
  const el = page.locator(fieldSel(p));
  await el.click();
  await el.evaluate((e) => e.setSelectionRange(0, 0));
  await page.keyboard.type(text, { delay: 30 });
  await sleep(150);
}
const valueAt = async (p) => (await page.locator(fieldSel(p)).inputValue()).replace(/\s+$/, "");
/** いま focus がどの欄にあるか（`f<row>c<col>`。欄の外なら undefined） */
const focusedField = () => page.evaluate(() => document.activeElement?.getAttribute?.("data-field") ?? undefined);
const opmsg = async () => {
  const m = page.locator(".opmsg");
  return (await m.count()) ? (await m.first().innerText()).trim() : "";
};
/** 画面テキストの 1 行（出力専用の欄は入力欄ではなくセルとして出るのでテキストから拾う） */
async function screenLine(row) {
  return page.evaluate((r) => {
    const rows = [...document.querySelectorAll(".grid-row")];
    return (rows[r - 1]?.textContent ?? "").replace(/ /g, " ");
  }, row);
}

try {
  await page.goto(`http://localhost:${PORT}/`);
  await page.waitForSelector(".launcher", { timeout: 20000 });
  if ((await page.locator(".card:has-text('DSP')").count()) === 0) {
    await page.click(".card:has-text('AS400') >> button:has-text('選択')");
    await page.waitForSelector(".card:has-text('DSP')", { timeout: 10000 });
  }
  let opened = false;
  for (let a = 1; a <= 6 && !opened; a++) {
    await page.click(".card:has-text('DSP') >> button:has-text('接続')");
    try { await page.waitForSelector("input.grid-input", { timeout: 20000 }); opened = true; }
    catch { log(`  （装置が空くのを待つ ${a}）`); await sleep(9000); }
  }
  check(opened, "実機へ接続して画面が出る");
  if (!opened) throw new Error("接続できない");
  await sleep(1200);

  // サインオン・回復画面を抜けてコマンド行へ
  for (let i = 0; i < 8; i++) {
    const t = await page.locator(".pane").innerText();
    if (t.includes("コマンドを入力") || t.includes("選択項目またはコマンド")) break;
    if (t.includes("サイン・オン")) {
      await page.keyboard.type(user);
      await page.keyboard.press("Tab");
      await page.keyboard.type(process.env.AS400_PASSWORD);
    } else if (t.includes("回復")) {
      await page.keyboard.type("90");
    }
    await page.keyboard.press("Enter");
    await sleep(2500);
  }

  await page.keyboard.type(`CALL ${LIB}/AUDPGM`);
  await page.keyboard.press("Enter");
  await sleep(3000);
  const body = await page.locator(".pane").innerText();
  if (process.env.VERIFY_DEBUG === "1") log("screen:\n" + body);
  check(body.includes("FIELD RULE TEST"), "AUDPGM のテスト画面が出ている");

  // --- ① 数字専用欄に `.` は打てない ---
  log("\n### ① 数字専用欄（DGT）");
  // **通知は次の打鍵で消える**ので、弾かれた直後に読む（`1` → `.` → 読む → `5`）
  await typeAt(DGT, "1");
  await page.keyboard.type(".");
  await sleep(200);
  const msg1 = await opmsg();
  await page.keyboard.type("5");
  await sleep(200);
  const v1 = await valueAt(DGT);
  log(`  DGT に "1.5" と打った結果: ${JSON.stringify(v1)} / 通知（. の直後）: ${JSON.stringify(msg1)}`);
  check(v1 === "15", `\`.\` が入らない（実際 ${JSON.stringify(v1)}）`);
  check(msg1.includes("数字"), `弾いた理由が画面に出る（実際 ${JSON.stringify(msg1)}）`);

  // --- ② `-` が Field− に化けない ---
  log("\n### ② 数字専用欄の `-`");
  await typeAt(DGT, "1234");
  await page.keyboard.type("-");
  await sleep(200);
  const v2 = await valueAt(DGT);
  const f2 = await focusedField();
  log(`  DGT に "1234-" と打った結果: ${JSON.stringify(v2)} / focus: ${f2}`);
  check(v2 === "1234", `打った桁が消えない（実際 ${JSON.stringify(v2)}）`);
  check(f2 === `f${DGT.row}c${DGT.col}`, `次の欄へ飛ばない（実際 ${f2}）`);

  // --- ③ 符号付き数値欄の符号桁 ---
  log("\n### ③ 符号付き数値欄（SGN・6S 0 ＝ワイヤ長 7）");
  await typeAt(SGN, "1234567");
  const v3 = await valueAt(SGN);
  log(`  SGN に "1234567" と打った結果: ${JSON.stringify(v3)} / 通知: ${JSON.stringify(await opmsg())}`);
  check(v3 === "123456", `符号桁に 7 桁目が入らない（実際 ${JSON.stringify(v3)}）`);

  // --- ④ 画面の値がそのままホストへ届く ---
  log("\n### ④ ホストが受け取った値");
  const shotBefore = join(OUT, "keystroke-rules-typed.png");
  await page.locator(".pane").screenshot({ path: shotBefore });
  await page.keyboard.press("Enter");
  await sleep(2500);
  const eDgt = (await screenLine(ECHO_DGT_ROW)).trim().replace(/^DGT\s*/, "").trim();
  const eSgn = (await screenLine(ECHO_SGN_ROW)).trim().replace(/^SGN\s*/, "").trim();
  const shot = join(OUT, "keystroke-rules-echo.png");
  await page.locator(".pane").screenshot({ path: shot });
  log(`  HOST RECEIVED  DGT=${JSON.stringify(eDgt)} SGN=${JSON.stringify(eSgn)}`);
  log(`  画像: ${shotBefore} / ${shot}`);
  check(eDgt === "1234", `DGT はホストへ 1234 として届く（実際 ${JSON.stringify(eDgt)}）`);
  check(/^0*123456$/.test(eSgn), `SGN はホストへ 123456 として届く（実際 ${JSON.stringify(eSgn)}）`);
  // **画面に見えている桁がそのままホストへ行く**——これがこの検証の要。
  // 直す前は SGN が画面 "1234567" / ホスト "123456" と食い違っていた。
  check(
    v3.replace(/^0+/, "") === eSgn.replace(/^0+/, ""),
    `SGN は画面とホストで一致する（画面 ${JSON.stringify(v3)} / ホスト ${JSON.stringify(eSgn)}）`
  );

  // --- ⑤ 送信が拒否されたら理由が出る（打鍵では作れない値をペーストで作る） ---
  log("\n### ⑤ ペースト経路（打てない文字が値に入らないか）");
  await page.evaluate(() => navigator.clipboard.writeText("1.5"));
  const dgtEl = page.locator(fieldSel(DGT));
  await dgtEl.click();
  await dgtEl.evaluate((e) => e.setSelectionRange(0, 0));
  await page.keyboard.press("Control+v");
  await sleep(300);
  const pasted = await valueAt(DGT);
  log(`  "1.5" をペーストした結果: ${JSON.stringify(pasted)}`);
  if (pasted.includes(".")) {
    // 値が作れてしまったら、**送信の拒否が画面に出るか**まで見る（黙って無反応にしない）
    await page.keyboard.press("Enter");
    await sleep(2000);
    const msg = await opmsg();
    log(`  Enter → 通知: ${JSON.stringify(msg)}`);
    check(msg.includes("送信しませんでした"), "拒否された理由が画面に出る");
  } else {
    check(true, "ペーストでも `.` は数字専用欄に入らない（送れない値を作らない）");
  }

  await page.keyboard.press("F3");
  await sleep(1500);
} catch (err) {
  check(false, err instanceof Error ? err.message : String(err));
} finally {
  await browser.close();
  await new Promise((r) => server.close(r));
  rmSync(work, { recursive: true, force: true });
}

log(`\n${fail === 0 ? "すべて PASS" : `FAIL ${fail} 件`}（PASS ${pass}）`);
process.exit(fail === 0 ? 0 : 1);
