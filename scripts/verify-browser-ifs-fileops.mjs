// 実ブラウザ（web-ui）で実機の IFS ペインを一通り操作する E2E。
//
// `/home/USER/TEST` を作り、**画面の操作だけ**で次を確かめる:
//   フォルダ: 作成 / 一覧に出る / まとめてダウンロード（zip） / 改名 / 削除（中身ごと）/ アップロード可否
//   ファイル: アップロード / プレビュー / 保存（編集）/ ダウンロード（中身一致）/ 改名 / 削除
//
// **API で作って UI で確かめる、をやらない。** 作成もアップロードも画面の操作で行う——
// 「画面から一通り行えるか」が問いなので、下回りだけ通っても答えにならない。
// 検証は画面の一覧だけに頼らず、**ホストの実体**（IFS API の list / read）でも突き合わせる。
//
// 前提: npm run build && npm run build -w @ts5250/web-ui。`connections.json` に実機。
// 実行: node --env-file=.env scripts/verify-browser-ifs.mjs
import { readFileSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
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

const PORT = 3487;
const BASE = "/home/USER";
const DIR = `${BASE}/TEST`;
const TMP = process.env.IFS_TMP ?? "/tmp/as400-verify-ifs";
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
const sys = conn.systems.find((s) => s.name === "実機");
if (!sys) throw new Error("connections.json に実機がない");
const resolver = new ConfigResolver(
  new ServerConfigStore({ systems: [], sessions: [] }, crypto),
  PersonalConfigStore.fromFile("connections.json", crypto)
);
const app = buildApp({
  sessions: new SessionManager(),
  resolver,
  version: "verify-ifs",
  webRoot: "packages/web-ui/dist"
});
const wss = new WebSocketServer({ noServer: true });
const http = serve({ fetch: app.fetch, port: PORT, websocket: { server: wss } });
await sleep(600);

// ---- ホストの実体を見るための直呼び（**検証と後始末にだけ使う。操作は画面から**）----
const source = { system: `own:${sys.id}` };
const api = async (path, body) => {
  const res = await fetch(`http://localhost:${PORT}/api/host/ifs/${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ source, ...body })
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
};
const hostNames = async (path) => {
  const r = await api("list", { path });
  return r.status === 200 ? r.body.entries.map((e) => e.name) : [`<${r.status} ${r.body.code ?? ""}>`];
};
const hostRead = async (path) => {
  const r = await api("read", { path });
  return r.status === 200 ? r.body.content : undefined;
};

// 前回の残骸があると「作成」が ALREADY_EXISTS で落ちる。開始時に片付ける
await api("delete", { path: DIR, recursive: true });

// ---- ブラウザ ----
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1600, height: 900 }, acceptDownloads: true });
page.on("pageerror", (e) => log(`PAGEERR ${e.message}`));
page.on("console", (m) => {
  if (m.type() === "error") log(`[console] ${m.text()}`);
});

// **ダイアログのハンドラは 1 つだけ**（二重登録は Playwright が落ちる）。
// prompt の答えは呼ぶ側が直前に差し替える
let promptAnswer = "";
let confirmAnswer = true;
const dialogs = [];
page.on("dialog", async (d) => {
  dialogs.push({ type: d.type(), message: d.message() });
  if (d.type() === "prompt") await d.accept(promptAnswer);
  else if (confirmAnswer) await d.accept();
  else await d.dismiss();
});
const lastDialog = () => dialogs.at(-1)?.message ?? "";

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const row = (name) =>
  page
    .locator(".entries li")
    .filter({ has: page.locator(".name").filter({ hasText: new RegExp(`^${esc(name)}$`) }) })
    .first();
const names = () => page.locator(".entries .name").allTextContents();
const waitIdle = async () => {
  // 通信中は操作ボタンが disabled になる。**固定待機にしない**（実機は 1 往復 0.5〜1 秒）
  await page
    .waitForFunction(
      () => {
        const b = document.querySelector("header button");
        return b !== null && !b.disabled;
      },
      undefined,
      { timeout: 120000 }
    )
    .catch(() => {});
};
const shot = async (n) => await page.screenshot({ path: `${SHOTS}/${n}.png` }).catch(() => {});
// **無いときに textContent を呼ばない。** locator は現れるまで待つので、
// 「エラーが出ていない」を確かめるつもりが 30 秒のタイムアウトで落ちる
const errText = async () =>
  (await page.locator("p.error").count()) === 0
    ? ""
    : ((await page.locator("p.error").first().textContent()) ?? "").trim();

const zipNames = (file) =>
  execFileSync("python3", [
    "-c",
    "import sys,zipfile;print('\\n'.join(zipfile.ZipFile(sys.argv[1]).namelist()))",
    file
  ])
    .toString()
    .trim()
    .split("\n")
    .filter(Boolean);

try {
  await page.goto(`http://localhost:${PORT}/`);

  // システムを選ぶ（connections.json に 2 システムあるので既定では決まらない）
  await page.locator(".card", { hasText: "実機" }).first().waitFor({ timeout: 30000 });
  await page.locator(".card", { hasText: "実機" }).first().locator("button", { hasText: "選択" }).click();

  // ランチャーの「IFS」カードを開く
  await page.locator(".fn", { hasText: "IFS" }).first().locator("button").first().click();
  await page.waitForSelector(".ifs", { timeout: 30000 });
  await page.locator(".entries li").first().waitFor({ timeout: 60000 });

  // ---- /home/USER まで辿る ----
  for (const [step, expect] of [
    ["home", "USER"],
    ["USER", "builds"]
  ]) {
    await row(step).click();
    await row(expect).waitFor({ timeout: 60000 });
  }
  const crumbs = (await page.locator("nav.crumbs button").allTextContents()).join("/");
  check("/home/USER まで辿れる", crumbs.includes("home") && crumbs.includes("USER"), crumbs);
  await shot("01-asao");

  // ---- 1. フォルダの作成（新規フォルダ → TEST）----
  promptAnswer = "TEST";
  await page.locator("header button", { hasText: "新規フォルダ" }).click();
  await row("TEST").waitFor({ timeout: 60000 }).catch(() => {});
  const afterMk = await names();
  check(
    "フォルダを作成できる（TEST）",
    afterMk.includes("TEST") && (await hostNames(BASE)).includes("TEST"),
    afterMk.filter((n) => n === "TEST").length ? "一覧・ホストの両方に出る" : afterMk.join(", ")
  );

  // ---- TEST に入る ----
  await row("TEST").click();
  await page.locator(".entries .empty").waitFor({ timeout: 60000 }).catch(() => {});
  check(
    "作ったフォルダに入れる（空と表示）",
    (await page.locator(".entries .empty").count()) === 1,
    (await names()).join(", ") || "（空）"
  );
  await shot("02-test-empty");

  // ---- 2. ファイルのアップロード（テキスト＋バイナリ、日本語ファイル名も）----
  const textBody = "IFS テスト\n日本語の行\nthird line\n";
  // **フォルダ用の input と区別する。** `input[type=file]` は 2 つある（strict で落ちる）
  await page.setInputFiles('input[type="file"]:not([webkitdirectory])', [
    { name: "hello.txt", mimeType: "text/plain", buffer: Buffer.from(textBody, "utf8") },
    {
      name: "日本語ファイル.txt",
      mimeType: "text/plain",
      buffer: Buffer.from("にほんご\n", "utf8")
    },
    {
      name: "dot.png",
      mimeType: "image/png",
      buffer: Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
        "base64"
      )
    }
  ]);
  await row("hello.txt").waitFor({ timeout: 120000 }).catch(() => {});
  await waitIdle();
  const upNames = await names();
  const hostAfterUp = await hostNames(DIR);
  check(
    "ファイルをアップロードできる（3 件）",
    ["hello.txt", "日本語ファイル.txt", "dot.png"].every((n) => upNames.includes(n) && hostAfterUp.includes(n)),
    `画面=[${upNames.join(", ")}] ホスト=[${hostAfterUp.join(", ")}]`
  );
  await shot("03-uploaded");

  // ---- 3. プレビュー（アップロードした中身が読める）----
  await row("hello.txt").click();
  await page.locator(".preview textarea.editor").waitFor({ timeout: 60000 }).catch(() => {});
  const shown = await page.locator(".preview textarea.editor").inputValue().catch(() => "");
  check("アップロードしたテキストが画面で読める", shown === textBody, JSON.stringify(shown));

  // 画像も描画されるか（src が付いただけでは分からないので naturalWidth で見る）
  await row("dot.png").click();
  await page.locator(".preview img").waitFor({ timeout: 60000 }).catch(() => {});
  await page
    .waitForFunction(() => (document.querySelector(".preview img")?.naturalWidth ?? 0) > 0, undefined, {
      timeout: 30000
    })
    .catch(() => {});
  const natural = await page.locator(".preview img").evaluate((el) => el.naturalWidth).catch(() => 0);
  check("アップロードした画像が描画される", natural > 0, `naturalWidth=${natural}`);

  // ---- 4. 編集して保存（ホストの実体で確かめる）----
  // **元より短い内容に書き換える**のが要。OPEN を「開くだけ」で書くと先頭からの上書きになり、
  // 41 バイトのファイルに 19 バイト保存して末尾 22 バイトが旧内容のまま残る
  // （実機で踏んだ壊れ方。`FILE_DUPLICATE.createOrReplace` で直した）。
  // 長い内容に書き換えるテストでは通ってしまうので、ここは必ず短くする
  await row("hello.txt").click();
  await page
    .waitForFunction(
      (t) => (document.querySelector(".preview textarea.editor")?.value ?? "") === t,
      textBody,
      { timeout: 60000 }
    )
    .catch(() => {});
  await page.locator(".preview textarea.editor").fill("編集しました\n");
  await page.locator(".preview .actions button", { hasText: "保存" }).click();
  // **「保存しました」を待ってから測る。** `waitIdle` はクリック直後だと busy が立つ前に
  // 通ってしまい、書き込みの前に一覧を読んで「まだ 41 バイト」を掴む（実際にこれで誤判定した）
  await page.locator("p.note", { hasText: "保存しました" }).waitFor({ timeout: 120000 }).catch(() => {});
  await waitIdle();
  const savedSize = (await api("list", { path: DIR })).body.entries?.find(
    (e) => e.name === "hello.txt"
  )?.size;
  check(
    "編集した内容を保存できる（短くしても末尾が残らない）",
    (await hostRead(`${DIR}/hello.txt`)) === "編集しました\n" && savedSize === 19,
    `size=${savedSize}（期待 19）content=${JSON.stringify(await hostRead(`${DIR}/hello.txt`))}`
  );

  // ---- 5. ファイルのダウンロード（**中身まで**突き合わせる）----
  const dlWait = page.waitForEvent("download", { timeout: 60000 });
  await page.locator(".preview .actions button", { hasText: "ダウンロード" }).click();
  const dl = await dlWait.catch(() => undefined);
  let dlBody;
  if (dl) {
    const p = `${TMP}/${dl.suggestedFilename()}`;
    await dl.saveAs(p);
    dlBody = readFileSync(p, "utf8");
  }
  check(
    "ファイルをダウンロードできる（中身も一致）",
    dl !== undefined && dl.suggestedFilename() === "hello.txt" && dlBody === "編集しました\n",
    dl ? `${dl.suggestedFilename()} ${JSON.stringify(dlBody)}` : "降ってこない"
  );

  // ---- 6. ファイルの改名 ----
  promptAnswer = "renamed.txt";
  await page.locator(".preview .actions button", { hasText: "名前の変更" }).click();
  await row("renamed.txt").waitFor({ timeout: 60000 }).catch(() => {});
  await waitIdle();
  const afterRenameFile = await names();
  const hostAfterRenameFile = await hostNames(DIR);
  check(
    "ファイルを改名できる（hello.txt → renamed.txt）",
    afterRenameFile.includes("renamed.txt") &&
      !afterRenameFile.includes("hello.txt") &&
      hostAfterRenameFile.includes("renamed.txt") &&
      !hostAfterRenameFile.includes("hello.txt"),
    `画面=[${afterRenameFile.join(", ")}] ホスト=[${hostAfterRenameFile.join(", ")}]`
  );
  await shot("04-renamed-file");

  // ---- 7. サブフォルダを作り、中にファイルを置く（zip とフォルダ操作の材料）----
  promptAnswer = "SUB";
  await page.locator("header button", { hasText: "新規フォルダ" }).click();
  await row("SUB").waitFor({ timeout: 60000 }).catch(() => {});
  await row("SUB").click();
  await waitIdle();
  // **フォルダ用の input と区別する。** `input[type=file]` は 2 つある（strict で落ちる）
  await page.setInputFiles('input[type="file"]:not([webkitdirectory])', [
    { name: "inner.txt", mimeType: "text/plain", buffer: Buffer.from("inner\n", "utf8") }
  ]);
  await row("inner.txt").waitFor({ timeout: 120000 }).catch(() => {});
  await waitIdle();
  check(
    "サブフォルダを作って中にファイルを置ける",
    (await hostNames(`${DIR}/SUB`)).includes("inner.txt"),
    (await hostNames(`${DIR}/SUB`)).join(", ")
  );

  // ---- 8. フォルダのダウンロード（zip。**中身の並びまで**見る）----
  // 「まとめてダウンロード」は**いま開いているフォルダ**が対象。TEST に戻ってから押す
  await page.locator("nav.crumbs button", { hasText: "TEST" }).first().click();
  await row("SUB").waitFor({ timeout: 60000 });
  await waitIdle();
  const zipWait = page.waitForEvent("download", { timeout: 180000 });
  await page.locator("header button", { hasText: "まとめてダウンロード" }).click();
  const zip = await zipWait.catch(() => undefined);
  let inZip = [];
  if (zip) {
    const p = `${TMP}/${zip.suggestedFilename()}`;
    await zip.saveAs(p);
    inZip = zipNames(p);
  }
  check(
    "フォルダを zip でダウンロードできる（中身も入る）",
    zip !== undefined &&
      zip.suggestedFilename() === "TEST.zip" &&
      inZip.some((n) => n.endsWith("renamed.txt")) &&
      inZip.some((n) => n.endsWith("inner.txt")),
    zip ? `${zip.suggestedFilename()} [${inZip.join(", ")}]` : "降ってこない"
  );

  // ---- 9. フォルダの改名（行末の「…」で開かずに選ぶ → 名前の変更）----
  await row("SUB").locator("button.pick").click();
  await page.locator(".preview .note", { hasText: "フォルダを選択中" }).waitFor({ timeout: 30000 }).catch(() => {});
  promptAnswer = "SUB2";
  await page.locator(".preview .actions button", { hasText: "名前の変更" }).click();
  await row("SUB2").waitFor({ timeout: 60000 }).catch(() => {});
  await waitIdle();
  const afterRenameDir = await names();
  const hostAfterRenameDir = await hostNames(DIR);
  check(
    "フォルダを改名できる（SUB → SUB2）",
    afterRenameDir.includes("SUB2") &&
      !afterRenameDir.includes("SUB") &&
      hostAfterRenameDir.includes("SUB2") &&
      (await hostNames(`${DIR}/SUB2`)).includes("inner.txt"),
    `画面=[${afterRenameDir.join(", ")}] ホスト=[${hostAfterRenameDir.join(", ")}]`
  );
  await shot("05-renamed-dir");

  // ---- 10. フォルダのアップロード ----
  // 「フォルダをアップロード」の入力は `webkitdirectory`（フォルダしか選べない）。
  // Playwright はこの入力にディレクトリのパスを渡せる
  const dirInput = page.locator('input[webkitdirectory]');
  check(
    "フォルダを選ぶ入口がある",
    (await dirInput.count()) === 1,
    `input[webkitdirectory] = ${await dirInput.count()} 個`
  );

  // 送る木を作る。**入れ子と日本語名を含める**——階層の作り忘れと符号化は別々に壊れる
  const TREE = `${TMP}/UPDIR`;
  mkdirSync(`${TREE}/sub/deep`, { recursive: true });
  writeFileSync(`${TREE}/top.txt`, "top\n");
  writeFileSync(`${TREE}/sub/mid.txt`, "mid\n");
  writeFileSync(`${TREE}/sub/deep/日本語.txt`, "ふかい\n");
  await dirInput.setInputFiles(TREE);
  await row("UPDIR").waitFor({ timeout: 180000 }).catch(() => {});
  await waitIdle();
  const upErr = await errText();
  const hostTop = await hostNames(`${DIR}/UPDIR`);
  const hostSub = await hostNames(`${DIR}/UPDIR/sub`);
  const hostDeep = await hostNames(`${DIR}/UPDIR/sub/deep`);
  check(
    "フォルダを階層ごとアップロードできる",
    (await names()).includes("UPDIR") &&
      hostTop.includes("top.txt") &&
      hostTop.includes("sub") &&
      hostSub.includes("mid.txt") &&
      hostDeep.includes("日本語.txt"),
    upErr
      ? `画面のメッセージ: ${upErr}`
      : `UPDIR=[${hostTop.join(", ")}] sub=[${hostSub.join(", ")}] deep=[${hostDeep.join(", ")}]`
  );
  check(
    "深い階層の中身も壊れずに届く",
    (await hostRead(`${DIR}/UPDIR/sub/deep/日本語.txt`)) === "ふかい\n",
    JSON.stringify(await hostRead(`${DIR}/UPDIR/sub/deep/日本語.txt`))
  );
  await shot("06-uploaded-folder");

  // 置いたフォルダは片付ける（このあとの削除の確認件数を素直に保つ）
  await row("UPDIR").locator("button.pick").click();
  await page.locator(".preview .note", { hasText: "フォルダを選択中" }).waitFor({ timeout: 30000 }).catch(() => {});
  await page.locator(".preview .actions button", { hasText: "削除" }).click();
  await row("UPDIR").waitFor({ state: "detached", timeout: 180000 }).catch(() => {});
  await waitIdle();

  // ---- 11. ファイルの削除 ----
  await row("renamed.txt").click();
  await page.locator(".preview .actions button", { hasText: "削除" }).click();
  await row("renamed.txt").waitFor({ state: "detached", timeout: 60000 }).catch(() => {});
  await waitIdle();
  const afterDelFile = await names();
  check(
    "ファイルを削除できる",
    !afterDelFile.includes("renamed.txt") && !(await hostNames(DIR)).includes("renamed.txt"),
    `確認=「${lastDialog()}」 画面=[${afterDelFile.join(", ")}]`
  );

  // ---- 12. フォルダの削除（中身ごと。件数を先に数えて確認する）----
  await row("SUB2").locator("button.pick").click();
  await page.locator(".preview .note", { hasText: "フォルダを選択中" }).waitFor({ timeout: 30000 }).catch(() => {});
  await page.locator(".preview .actions button", { hasText: "削除" }).click();
  await row("SUB2").waitFor({ state: "detached", timeout: 120000 }).catch(() => {});
  await waitIdle();
  const delDialog = lastDialog();
  check(
    "中身のあるフォルダを削除できる（件数を確認してから）",
    !(await names()).includes("SUB2") &&
      !(await hostNames(DIR)).includes("SUB2") &&
      /ファイル 1 件/.test(delDialog),
    `確認=「${delDialog}」`
  );
  await shot("07-after-delete");

  // ---- 13. テスト用フォルダ自体を画面から削除（後始末も画面の操作で）----
  await page.locator("nav.crumbs button", { hasText: "USER" }).first().click();
  await row("TEST").waitFor({ timeout: 60000 });
  await waitIdle();
  await row("TEST").locator("button.pick").click();
  await page.locator(".preview .note", { hasText: "フォルダを選択中" }).waitFor({ timeout: 30000 }).catch(() => {});
  await page.locator(".preview .actions button", { hasText: "削除" }).click();
  await row("TEST").waitFor({ state: "detached", timeout: 120000 }).catch(() => {});
  await waitIdle();
  check(
    "テスト用フォルダを画面から片付けられる",
    !(await hostNames(BASE)).includes("TEST"),
    `確認=「${lastDialog()}」`
  );
  await shot("08-cleaned");
} catch (e) {
  check("スクリプトが最後まで走る", false, String(e?.stack ?? e));
  await shot("99-crash");
} finally {
  // 画面から消せていなくても残置しない
  const left = await hostNames(BASE);
  if (left.includes("TEST")) {
    await api("delete", { path: DIR, recursive: true });
    log("後始末: /home/USER/TEST を API で削除した");
  }
  writeFileSync(`${TMP}/dialogs.json`, JSON.stringify(dialogs, null, 2));
  await browser.close();
  http.close();
  wss.close();
}

const failed = results.filter((r) => !r.ok);
process.stdout.write(`\n${results.length - failed.length}/${results.length} 成功（画像: ${SHOTS}）\n`);
process.exit(failed.length > 0 ? 1 : 0);
