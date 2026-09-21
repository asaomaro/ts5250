// **挿入モードで欄が満杯のとき、あふれた末尾を黙って捨てる欠陥を実機で観測する**（修正前の証跡）。
//
// `20260920-insert-mode-overflow` の AC8 / AC2b。**修正を当てると再現しないので、先に取る。**
//
// 見たいのは 2 つ:
//   (1) **画面の値**——符号付き数値欄 `    12-` の途中に挿入すると、**符号桁の `-` が落ちる**
//   (2) **ホストが受け取る値**——落ちた結果、ホストは **負値ではなく正値**として受け取る
//       （単体テストは送信バイトまでしか見ない。ホストの解釈は実機に聞くほかない
//        ——`verify-browser-sign.mjs` の冒頭がそう書いている）
//
// 条項 `measurement-sanity`（1 回の観測で決めない）に従い、**2 つの経路**で取る:
//   経路 A: 打鍵（`typeChar`）  経路 B: 貼り付け（`insertInto`）
// どちらも「あふれた末尾を黙って捨てる」経路だが、**実装は別**（research F7）。
//
// 画面は `scripts/build-sgntest.mjs`（TESTLIB/SGNPGM）が作る。**このスクリプトは作らない**
// ——先に `node scripts/build-sgntest.mjs` を回しておくこと。オブジェクトの後始末も同スクリプトの責務。
//
// 前提: npm run build 済み。`profiles.local.json` に実機のシステム／セッション（`.env.verify` が指す名前）。
// 実行: node --env-file=.env --env-file=.env.verify scripts/verify-browser-insert-overflow.mjs
import { mkdirSync } from "node:fs";
import { serve } from "@hono/node-server";
import { WebSocketServer } from "ws";
import { buildApp, SessionManager, ServerConfigStore, PersonalConfigStore, ConfigResolver } from "@ts5250/server";
import { SecretCrypto } from "../packages/server/dist/secret-crypto.js";
import { chromium } from "playwright";

const log = (s) => process.stderr.write(s + "\n");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const PORT = 3486;
const TMP = process.env.INS_TMP ?? "/tmp/as400-verify-insert-overflow";
mkdirSync(TMP, { recursive: true });

// **観測を記録するだけで、合否は付けない。** ここで見たいのは「欠陥が実在すること」で、
// 直った後にこのスクリプトを回すと当然「観測できない」になる。合否にすると意味が反転する
const notes = [];
const note = (n, v) => {
  notes.push({ n, v });
  process.stdout.write(`${n}: ${v}\n`);
};

const SYSTEM = process.env.AS400_SYSTEM ?? "AS400";
const SESSION = process.env.AS400_SESSION ?? "DEV1";
const LIB = process.env.AS400_LIB ?? "TESTLIB";
// **パスワードはスクリプトに書かない**（AGENTS.md セキュリティ）。値は出力もしない
const USER = process.env.AS400_USER ?? "";
const PASSWORD = process.env.AS400_PASSWORD ?? "";

// 設定は `profiles.local.json` から引く（`.env.verify` の AS400_SYSTEM / AS400_SESSION が指す先）。
// ※ `verify-browser-sign.mjs` は古い `connections.json` を読む世代で、この環境では動かない
const crypto = SecretCrypto.fromEnv();
const resolver = new ConfigResolver(
  ServerConfigStore.fromFile("profiles.local.json", crypto),
  new PersonalConfigStore({ systems: [], sessions: [] }, crypto)
);
const app = buildApp({ sessions: new SessionManager(), resolver, version: "verify", webRoot: "packages/web-ui/dist" });
const wss = new WebSocketServer({ noServer: true });
const server = serve({ fetch: app.fetch, port: PORT, websocket: { server: wss } });
await sleep(600);

const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1500, height: 820 } });
// **headless では clipboard が既定で拒否される。** 許可しないと `writeText` が黙って失敗し、
// Ctrl+V が何も貼らない——それを「貼り付けでは符号が落ちない」と読むと**誤った陰性**になる
await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: `http://localhost:${PORT}` });
const page = await context.newPage();
page.on("pageerror", (e) => log("PAGEERR " + e.message));

// **第 2 の経路: ワイヤ**（条項 `measurement-sanity`「別の経路でもう一度取る」）。
// 画面の値（DOM）と、**実際にサーバーへ出て行くフレーム**は別の層。
// 貼り付け経路は既に弾いていると分かったので、defect の 2 経路目はこちらで取る
const sentFields = [];
page.on("websocket", (ws) => {
  ws.on("framesent", ({ payload }) => {
    try {
      const m = JSON.parse(String(payload));
      if (m.type === "key" && m.fields) sentFields.push(m.fields);
    } catch {
      /* テキストでないフレームは見ない */
    }
  });
});

const bodyText = () => page.locator("body").innerText();
const has = async (t) => (await bodyText()).includes(t);
const clickEnter = async () => {
  const b = page.getByText("⏎ 実行", { exact: false }).first();
  if (await b.count()) await b.click();
  else await page.keyboard.press("Enter");
};
const inputs = () => page.locator("input.grid-input:not([readonly])");
const valueOf = async (i) => await inputs().nth(i).inputValue();
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

try {
  await page.goto(`http://localhost:${PORT}/`);
  await page.waitForSelector(".launcher", { timeout: 20000 });
  await page.click(`.card:has-text('${SYSTEM}') >> button:has-text('選択')`);
  await page.waitForSelector(`.card:has-text('${SESSION}')`, { timeout: 10000 });
  await page.click(`.card:has-text('${SESSION}') >> button:has-text('接続')`);
  await page.waitForFunction(
    () => /サインオン|ユーザー|回復|メインメニュー/.test(document.body.innerText),
    { timeout: 25000 }
  );
  await sleep(900);

  if ((await has("サイン")) && (await has("ユーザー"))) {
    await typeInto(0, USER);
    await typeInto(1, PASSWORD);
    await clickEnter();
  }
  for (let i = 0; i < 20; i++) {
    await sleep(1400);
    if (await has("メインメニュー")) break;
    if (await has("対話式ジョブの回復")) {
      const el = inputs().last();
      await el.click();
      await page.keyboard.press("Home");
      await page.keyboard.type("90", { delay: 30 });
      await clickEnter();
    } else if (await has("SIGN / DUP TEST")) {
      await page.keyboard.press("F3");
    } else await clickEnter();
  }
  if (!(await has("メインメニュー"))) {
    log("---- 到達できなかった画面 ----\n" + (await bodyText()).slice(0, 2000));
    throw new Error("メインメニューに到達できなかった");
  }
  await runCmd(`ADDLIBLE ${LIB}`);
  await runCmd(`CALL ${LIB}/SGNPGM`);
  try {
    await page.waitForFunction(() => document.body.innerText.includes("SIGN / DUP TEST"), { timeout: 20000 });
  } catch {
    throw new Error("SGNPGM の画面が出ない。先に `node scripts/build-sgntest.mjs` で画面を作ること");
  }

  // 欄の並び: 0=SGN(6S 0) 1=NUM(6 0) 2=NMO(6M) 3=DUPF(DUP)
  // `6S 0` は**符号桁を含めて 7 桁**表示される（`    12-`）。**末尾が符号なので空きは 0**
  // ——これが「末尾から空白を数える」方式で満杯と判定される形そのもの（design §2）

  // ---- 経路 A: 打鍵（typeChar）----
  await typeInto(0, "12");
  await page.keyboard.type("-", { delay: 30 });
  await sleep(300);
  const before = await valueOf(0);
  note("A-1 挿入前の値", JSON.stringify(before));

  await inputs().nth(0).click();
  await page.keyboard.press("Home");
  for (let i = 0; i < 4; i++) await page.keyboard.press("ArrowRight"); // `1` の上へ
  await page.keyboard.press("Insert"); // 挿入モード ON
  await sleep(200);
  await page.keyboard.type("9", { delay: 30 });
  await sleep(300);
  const afterA = await valueOf(0);
  note("A-2 挿入後の値（打鍵）", JSON.stringify(afterA));
  note("A-3 符号が落ちたか", afterA.includes("-") ? "落ちていない" : "**落ちた**");

  // ---- ホストが受け取る値 ----
  await clickEnter();
  await sleep(2200);
  // **エコーは保護欄（readonly の input）から直に読む。**
  // 画面テキストを `[` で濾すやり方は**この実機では効かない**——日本語 CCSID のため
  // `F3=exit Enter=echo` が `F3=ｵﾒｹﾎ Eﾄﾎｵﾈ=ｵｳｸﾅ` と化け、角括弧も化ける。
  // 数字と `-` は EBCDIC 930 でも 037 と同じ符号位置なので、**値そのものは読める**
  // **エコーは画面の出力欄から読む**（保護欄は input ではなく画面テキストとして描かれる）。
  // 角括弧は当てにしない——日本語 CCSID では `[` `]` が `ﾗ` `ﾝ` に化ける
  // （`F3=exit Enter=echo` も `F3=ｵﾒｹﾎ Eﾄﾎｵﾈ=ｵｳｸﾅ` と出る）。
  // **数字と `-` は EBCDIC 930 でも 037 と同じ符号位置なので、値そのものは読める**
  const gridText = await page.locator(".grid").innerText().catch(() => "");
  log("---- Enter 後の画面（.grid）----\n" + gridText.split("\n").filter((l) => /\S/.test(l)).join("\n"));
  // **ワイヤに出た値**（DOM とは別の層の観測）
  const lastSent = sentFields.at(-1);
  note("A-3b ワイヤに出た欄の値", JSON.stringify(lastSent ?? "(取れず)"));
  // 角括弧は化けうるので、**数字を含む保護欄**をエコーとみなす
  // `->` の右が出力欄。先頭行（S 6S0 ＝符号付き数値欄）のエコーだけを見る
  const echo = (gridText.split("\n").find((l) => l.includes("->") && /\d/.test(l)) ?? "")
    .split("->")[1]?.trim() ?? "";
  note("A-4 エコー（保護欄の値）", echo || "(読めず)");
  // **読めなかったら「未確認」。** 陰性（正値だった）と読んではいけない
  // ——`[-12]` が無いことは「正値だった」ではなく「エコーを読めていない」でも起こる
  const verdict = !echo
    ? "**未確認**（エコーを読めていない。陰性と読まないこと）"
    : /-\s*\d/.test(echo) || /\d+\s*-/.test(echo)
      ? "負値（符号は保たれた）"
      : "**正値（符号が失われた）**";
  note("A-5 ホストは負値として受け取ったか", verdict);

  // ---- 経路 B: 貼り付け（insertInto）----
  // 同じ「満杯の符号付き欄へ挿入」を、**実装の違う経路**でもう一度（条項 measurement-sanity）
  await page.keyboard.press("F3");
  await sleep(1200);
  await runCmd(`CALL ${LIB}/SGNPGM`);
  await page.waitForFunction(() => document.body.innerText.includes("SIGN / DUP TEST"), { timeout: 20000 });

  await typeInto(0, "12");
  await page.keyboard.type("-", { delay: 30 });
  await sleep(300);
  const beforeB = await valueOf(0);
  note("B-1 挿入前の値", JSON.stringify(beforeB));

  await inputs().nth(0).click();
  await page.keyboard.press("Home");
  for (let i = 0; i < 4; i++) await page.keyboard.press("ArrowRight");
  // 挿入モードのまま貼り付ける（Insert は欄をまたいでも保たれる想定。値で確かめる）
  // **貼り付けが本当に発火したかを先に確かめる。** 発火していないのに値が変わらないのを
  // 「貼り付けでは落ちない」と読むと誤った陰性になる（1 回目の観測がまさにそれだった）
  const wrote = await page.evaluate(async () => {
    try {
      await navigator.clipboard.writeText("9");
      return await navigator.clipboard.readText();
    } catch (e) {
      return `ERR:${e.name}`;
    }
  });
  note("B-2 クリップボードに書けたか", JSON.stringify(wrote));
  await page.keyboard.press("Control+v");
  await sleep(600);
  const afterB = await valueOf(0);
  note("B-3 挿入後の値（貼り付け）", JSON.stringify(afterB));
  if (wrote !== "9") {
    note("B-4 判定", "**未確認**（クリップボードに書けていないので貼り付けは発火していない）");
  } else if (afterB === beforeB) {
    note("B-4 判定", "値が変わらない——**貼り付け経路は既に弾いている**（通知の有無を要確認）");
  } else {
    note("B-4 判定", afterB.includes("-") ? "符号は保たれた" : "**符号が落ちた**");
  }

  await page.keyboard.press("F3");
  await sleep(1500);
  try {
    await runCmd("SIGNOFF");
    await sleep(1500);
  } catch (e) {
    log("SIGNOFF できなかった: " + e.message);
  }
} catch (e) {
  note("例外", e.message);
  log(e.stack ?? "");
} finally {
  await browser.close();
  server.close();
  wss.close();
}

process.stdout.write(`\n観測 ${notes.length} 件を記録した（合否判定はしない）\n`);
