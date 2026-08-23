// 実ブラウザ（web-ui）で実機へ接続し、**FFW の挙動ビット**が端から端まで効くか検証する。
//
//   MONOCASE          — 素の英数字欄で小文字が大文字になる／`CHECK(LC)` 欄では残る
//   FIELD_EXIT_REQUIRED — `CHECK(FE)` 欄は満杯でも次の欄へ飛ばない
//   AUTO_ENTER        — `CHECK(ER)` 欄が満杯になったら Enter が飛ぶ
//   MANDATORY_ENTER / MANDATORY_FILL — Enter を止めて操作員メッセージを出す（F3 は止めない）
//   シフト種別        — `X`（英字専用）が数字を弾き、`I`（キーボード入力不可）は何も受け付けない
//
// 単体テストは component まで（mount した ScreenGrid / EmulatorPane）しか見ていない。
// **core が立てたフラグが WS を通ってブラウザまで届いているか**はここでしか分からない。
//
// 画面は `scripts/build-adjtest.mjs`（ADJPGM）と
// `scripts/build-ffwtest.mjs`（FFWPGM）が作る。
//
// 前提: npm run build 済み。`connections.json` に実機と DEV1。
// 実行: AS400_PASSWORD=... node scripts/verify-browser-ffw.mjs
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { serve } from "@hono/node-server";
import { WebSocketServer } from "ws";
import { buildApp, SessionManager, ServerConfigStore, PersonalConfigStore, ConfigResolver } from "@ts5250/server";
import { SecretCrypto } from "../packages/server/dist/secret-crypto.js";
import { chromium } from "playwright";

const log = (s) => process.stderr.write(s + "\n");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const PORT = 3479;
const TMP = process.env.FFW_TMP ?? "/tmp/as400-verify-ffw";
mkdirSync(TMP, { recursive: true });

const results = [];
const check = (n, ok, d = "") => {
  results.push({ n, ok });
  process.stdout.write(`${ok ? "OK  " : "NG  "} ${n}${d ? ` — ${d}` : ""}\n`);
};

const cfg = JSON.parse(readFileSync("connections.json", "utf8"));
const tmpCfg = `${TMP}/conn-ffw.json`;
writeFileSync(tmpCfg, JSON.stringify(cfg));
const crypto = SecretCrypto.fromEnv();
const sys = cfg.systems.find((s) => s.name === (process.env.AS400_SYSTEM ?? "AS400"));
// **パスワードはスクリプトに書かない。** 環境変数か、暗号化済み設定の復号で得る（AGENTS.md セキュリティ）
const password = process.env.AS400_PASSWORD ?? crypto.decrypt(sys.signon.passwordEnc);
const user = sys.signon.user;

const resolver = new ConfigResolver(
  ServerConfigStore.fromFile(tmpCfg, crypto),
  new PersonalConfigStore({ systems: [], sessions: [] }, crypto)
);
const app = buildApp({ sessions: new SessionManager(), resolver, version: "verify", webRoot: "packages/web-ui/dist" });
const wss = new WebSocketServer({ noServer: true });
const server = serve({ fetch: app.fetch, port: PORT, websocket: { server: wss } });
await sleep(600);

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1500, height: 820 } });
page.on("pageerror", (e) => log("PAGEERR " + e.message));

const bodyText = () => page.locator("body").innerText();
const has = async (t) => (await bodyText()).includes(t);
const clickEnter = async () => {
  const b = page.getByText("⏎ 実行", { exact: false }).first();
  if (await b.count()) await b.click();
  else await page.keyboard.press("Enter");
};
const inputs = () => page.locator("input.grid-input:not([readonly])");
const valueOf = async (i) => await inputs().nth(i).inputValue();
const focusIndex = () =>
  page.evaluate(() => {
    const all = [...document.querySelectorAll("input.grid-input:not([readonly])")];
    return all.indexOf(document.activeElement);
  });
async function typeInto(i, text) {
  const el = inputs().nth(i);
  await el.click();
  await page.keyboard.press("Home");
  await page.keyboard.type(text, { delay: 20 });
  await sleep(150);
}
async function runCmd(text) {
  const el = inputs().last();
  await el.click();
  await page.keyboard.press("Home");
  await page.keyboard.type(text, { delay: 15 });
  await clickEnter();
  await sleep(1500);
}
/** ステータス行（操作員メッセージが出る所）のテキスト */
const statusText = () => page.locator(".oia").innerText().catch(() => "");

try {
  await page.goto(`http://localhost:${PORT}/`);
  await page.waitForSelector(".launcher", { timeout: 20000 });
  await page.click(".card:has-text('実機') >> button:has-text('選択')");
  await page.waitForSelector(".card:has-text('DEV1')", { timeout: 10000 });
  await page.click(".card:has-text('DEV1') >> button:has-text('接続')");
  await page.waitForFunction(
    () => /サインオン|ユーザー|回復|メインメニュー/.test(document.body.innerText),
    { timeout: 25000 }
  );
  await sleep(900);

  if ((await has("サイン") && await has("ユーザー"))) {
    await typeInto(0, user);
    await typeInto(1, password);
    log(`signon 入力: user=${JSON.stringify(await valueOf(0))} pw.len=${(await valueOf(1)).trim().length} notice=${await statusText()}`);
    await clickEnter();
  }
  // 装置名を使い回すため、前回の実行が残っていると回復画面やテスト画面から始まる。
  // 抜けるのに数往復かかるので回数は多めに取る（scripts/README.md）
  for (let i = 0; i < 20; i++) {
    await sleep(1400);
    if (await has("メインメニュー")) break;
    if (await has("対話式ジョブの回復")) {
      const el = inputs().last();
      await el.click();
      await page.keyboard.press("Home");
      await page.keyboard.type("90", { delay: 30 });
      await clickEnter();
    } else if ((await has("FFW ADJUST TEST")) || (await has("FFW BEHAVIOR BITS TEST"))) {
      await page.keyboard.press("F3"); // 前回のテスト画面が残っていたら抜ける
    } else await clickEnter();
  }
  const reached = await has("メインメニュー");
  if (!reached) log("---- 到達できなかった画面 ----\n" + (await bodyText()).slice(0, 2200));
  check("メインメニューに到達", reached);
  await runCmd("ADDLIBLE TESTLIB");

  // ======================= FFWPGM: シフト種別・MONOCASE・AUTO_ENTER =======================
  // 欄の並び: 0=A素 1=A CHECK(LC) 2=X 3=N 4=W 5=D 6=I 7=M 8=A CHECK(ER)
  await runCmd("CALL TESTLIB/FFWPGM");
  await page.waitForFunction(() => document.body.innerText.includes("FFW BEHAVIOR BITS TEST"), { timeout: 20000 });
  const n1 = await inputs().count();
  check("FFWPGM の画面が出る（入力欄 9）", n1 === 9, `count=${n1}`);

  // --- MONOCASE: 素の英数字欄は大文字化、CHECK(LC) 欄は小文字が残る ---
  await typeInto(0, "abc");
  check("MONOCASE 欄で小文字が大文字になる", (await valueOf(0)).startsWith("ABC"), JSON.stringify(await valueOf(0)));
  await typeInto(1, "abc");
  check("**CHECK(LC) 欄では小文字が残る**", (await valueOf(1)).startsWith("abc"), JSON.stringify(await valueOf(1)));

  // --- 英字専用（X）: 数字を弾く ---
  await typeInto(2, "AB");
  await page.keyboard.type("1", { delay: 20 });
  await sleep(200);
  check("英字専用（X）欄が数字を弾く", (await valueOf(2)).replace(/ +$/, "") === "AB", JSON.stringify(await valueOf(2)));
  check("弾いた理由が操作員メッセージに出る", (await statusText()).includes("英字"), await statusText());

  // --- キーボード入力不可（I）: 何も入らない ---
  await typeInto(6, "ABC");
  check("キーボード入力不可（I）欄は何も受け付けない", (await valueOf(6)).trim() === "", JSON.stringify(await valueOf(6)));
  check("その理由も操作員メッセージに出る", (await statusText()).includes("キーボード"), await statusText());

  // --- AUTO_ENTER（CHECK(ER)）: 満杯で Enter が飛ぶ ---
  // 6 桁を打ち切ると Enter が送られ、RPG が exfmt し直すので**欄が空に戻る**
  await typeInto(8, "ABCDEF");
  await sleep(2500);
  const after = await valueOf(8);
  check("AUTO_ENTER 欄が満杯で Enter を送る（画面が返ってきて欄が空に戻る）", after.trim() === "", JSON.stringify(after));

  await page.keyboard.press("F3");
  await sleep(1500);

  // ======================= ADJPGM: FER と必須検証 =======================
  // 欄の並び: 0=RZ 1=RB 2=MF 3=FE 4=ME 5=素 6=NRZ 7=NPLN 8=SPLN
  await runCmd("CALL TESTLIB/ADJPGM");
  await page.waitForFunction(() => document.body.innerText.includes("FFW ADJUST TEST"), { timeout: 20000 });
  const n2 = await inputs().count();
  check("ADJPGM の画面が出る（入力欄 9）", n2 === 9, `count=${n2}`);

  // --- FER: 満杯でも次の欄へ飛ばない ---
  await typeInto(3, "ABCDEF"); // 欄 3 = CHECK(FE)・6 桁
  const fiFer = await focusIndex();
  check("FER 欄は満杯でも次の欄へ飛ばない", fiFer === 3, `focusIndex=${fiFer}`);

  // --- FER でない欄は従来どおり飛ぶ（対照） ---
  await typeInto(5, "ABCDEF"); // 欄 5 = 素の英数字・6 桁
  const fiPlain = await focusIndex();
  check("FER でない欄は満杯で次の欄へ飛ぶ（回帰の確認）", fiPlain === 6, `focusIndex=${fiPlain}`);

  // --- MANDATORY_ENTER: 欄 4 が空のまま Enter → 送らない ---
  // **OIA の「⏎ 実行」ボタンで押す**（clickEnter）。ここが `EmulatorPane.onAid` を通らない
  // 経路で、実装当初はこのボタンだけ検証をすり抜けていた
  await clickEnter();
  await sleep(1500);
  check(
    "MANDATORY_ENTER 欄が空だと Enter を送らない（画面が変わらない）",
    (await has("FFW ADJUST TEST")) && !(await bodyText()).includes("[ABCDEF]"),
    "エコーが出ていたら送信されている"
  );
  check("必須入力のメッセージが出る", (await statusText()).includes("入力が必要"), await statusText());

  // --- MANDATORY_FILL: 欄 4 を埋め、欄 2 を部分入力にして Enter → 送らない ---
  await typeInto(4, "X"); // ME を満たす
  await typeInto(2, "12"); // MF を部分入力にする（6 桁中 2 桁）
  await clickEnter();
  await sleep(1500);
  // **「画面が変わらない」だけでは判定にならない**（RPG は同じ画面を出し直すため）。
  // 送信されたら AME に入れた "X" が `[X     ]` としてエコーされるので、それが出ないことを見る
  check("MANDATORY_FILL 欄が部分入力だと Enter を送らない", !(await bodyText()).includes("[X"));
  check("全桁充填のメッセージが出る", (await statusText()).includes("すべての桁"), await statusText());

  // --- F3 は止めない（必須欄が空でも画面から出られる） ---
  await page.keyboard.press("Control+Backspace"); // Erase Input で全欄を空へ（ME を空に戻す）
  await sleep(400);
  check("前提: Erase Input で必須欄が空になった", (await valueOf(4)).trim() === "");
  await page.keyboard.press("F3");
  await sleep(2000);
  check("**F3 は止めない**（必須欄が空でも抜けられる）", !(await has("FFW ADJUST TEST")));

  // **装置を解放してから終わる。** ブラウザを閉じるだけだとジョブが残り、
  // 次の実行が「対話式ジョブの回復」から始まって 1 回おきに失敗する（実測）。
  try {
    await runCmd("SIGNOFF");
    await sleep(1500);
  } catch (e) {
    log("SIGNOFF できなかった: " + e.message);
  }
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
