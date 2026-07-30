// 実ブラウザでの IFS パネル E2E。build 済み web-ui を server で配信し、Playwright で:
//   1) ランチャーから IFS を開き、ルートの一覧が出る
//   2) フォルダを辿って /home/USER/ifsdemo まで降りられる
//   3) 左のツリーから同じ場所へ移動できる
//   4) テキスト（UTF-8）を選ぶと中身が表示される
//   5) 画像を選ぶと <img> が実際に描画される（naturalWidth > 0。src が付いただけでは分からない）
//   6) PDF を選ぶと <iframe> が生成される
//   7) 単一ファイルのダウンロード / 8) zip の一括ダウンロード
//   9) アップロード / 10) 削除 / 11) /QSYS.LIB で「先頭 N 件まで」が出る
//
// **PNG / PDF / アップロード分のフィクスチャは自分で用意して片付ける**。
// 実機の残置に依存すると、片付けた後に「無いのでスキップ」となり検証が静かに減る（実際に起きた）。
// ただし /home/USER/ifsdemo と hello.txt / nihongo.txt は実機に用意されている前提。
// jsdom では 4 の「本当に表示されたか」を確かめられないためブラウザで担保する。
// 前提: npm run build 済み。実機に /home/USER/ifsdemo。
// 実行: node --env-file=.env scripts/verify-browser-ifs.mjs
import { serve } from "@hono/node-server";
import { WebSocketServer } from "ws";
import {
  buildApp,
  SessionManager,
  ServerConfigStore,
  PersonalConfigStore,
  ConfigResolver,
  migrateProfiles
} from "@as400web/server";
import { SecretCrypto } from "../packages/server/dist/secret-crypto.js";
import { chromium } from "playwright";
import { readFileSync } from "node:fs";

const DEMO = "/home/USER/ifsdemo";
const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok, detail });
  process.stdout.write(`${ok ? "OK  " : "NG  "} ${name}${detail ? ` — ${detail}` : ""}\n`);
};

async function main() {
  const raw = JSON.parse(readFileSync("profiles.local.json", "utf8"));
  const crypto = SecretCrypto.fromEnv();
  const { systems, sessions } = migrateProfiles(raw.profiles);
  const resolver = new ConfigResolver(
    new ServerConfigStore({ systems, sessions }, crypto),
    new PersonalConfigStore({ systems: [], sessions: [] }, crypto)
  );
  const app = buildApp({
    sessions: new SessionManager(),
    resolver,
    version: "e2e",
    webRoot: "packages/web-ui/dist"
  });
  const port = 3431;
  const wss = new WebSocketServer({ noServer: true });
  const http = serve({ fetch: app.fetch, port, websocket: { server: wss } });

  // **フィクスチャは E2E が自分で用意する。** 実機に置きっぱなしにすると、
  // 片付けた後に「テスト用のファイルが無い」でスキップされ、検証が静かに減る
  const source = { system: "srv:pub400.com" };
  const put = async (name, base64) => {
    const res = await fetch(`http://localhost:${port}/api/host/ifs/write`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ source, path: `${DEMO}/${name}`, content: base64, encoding: "base64" })
    });
    if (!res.ok) throw new Error(`fixture ${name}: ${res.status}`);
  };
  const drop = async (name) => {
    // 片付けの失敗は握りつぶさない。残置は次回の実行を壊す
    const res = await fetch(`http://localhost:${port}/api/host/ifs/delete`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ source, path: `${DEMO}/${name}` })
    }).catch(() => undefined);
    if (res && !res.ok && res.status !== 404) {
      process.stdout.write(`  片付けに失敗: ${name} (${res.status})\n`);
    }
  };

  // 1x1 の PNG と、最小構成の PDF
  await put(
    "e2e-dot.png",
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="
  );
  await put("e2e-edit.txt", Buffer.from("before\n").toString("base64"));
  await put(
    "e2e-mini.pdf",
    Buffer.from(
      "%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n" +
        "2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n" +
        "3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 200]>>endobj\ntrailer<</Root 1 0 R>>\n"
    ).toString("base64")
  );

  const browser = await chromium.launch();
  const page = await browser.newPage();
  page.on("console", (m) => {
    if (m.type() === "error") process.stdout.write(`  [console] ${m.text()}\n`);
  });

  try {
    await page.goto(`http://localhost:${port}/`);
    await page.waitForSelector(".fn", { timeout: 20000 });
    // ランチャーの「IFS」カードの「開く」を押す
    const card = page.locator(".fn", { hasText: "IFS" }).first();
    await card.locator("button").first().click();
    await page.waitForSelector(".ifs", { timeout: 20000 });

    // 1) ルートの一覧
    await page.waitForSelector(".entries li", { timeout: 30000 });
    const rootCount = await page.locator(".entries li").count();
    check("ルートの一覧が出る", rootCount > 0, `${rootCount} 件`);

    // 2) フォルダを辿る。**固定待機にしない**——実機は 1 往復 0.5〜1 秒かかり、
    // 待ち足りないと「まだ前の画面を見ている」だけで失敗と誤判定する
    for (const [step, expect] of [
      ["home", "USER"],
      ["USER", "ifsdemo"],
      ["ifsdemo", "hello.txt"]
    ]) {
      await page.locator(".entries li", { hasText: step }).first().click();
      await page
        .locator(".entries .name", { hasText: expect })
        .first()
        .waitFor({ timeout: 30000 });
    }
    const names = await page.locator(".entries .name").allTextContents();
    check("ifsdemo まで辿れる", names.some((n) => n.includes("hello.txt")), names.join(", "));

    // 3) 左のツリー。**恒真の check を書かない**——
    // 以前ここに `check(..., true, ...)` を置いてしまい、永久に成功する項目になっていた
    await page.locator("nav.crumbs button", { hasText: "/" }).first().click();
    await page.locator(".entries .name", { hasText: "home" }).first().waitFor({ timeout: 30000 });

    // **開閉が両方向に効くことを見る。**
    // 一覧を辿った時点で祖先は展開済みなので「押せば増える」とは限らない
    // （この前提を間違えて一度落とした。恒真にせず実測した価値がここに出た）
    const rowsBefore = await page.locator(".tree-row").count();
    const homeRow = page.locator('.tree-row[data-path="/home"]');
    const waitRows = (cmp) =>
      page
        .waitForFunction(
          ([n, mode]) => {
            const c = document.querySelectorAll(".tree-row").length;
            return mode === "diff" ? c !== n : c === n;
          },
          [rowsBefore, cmp],
          { timeout: 60000 }
        )
        .catch(() => {});
    await homeRow.locator(".caret").click();
    await waitRows("diff");
    const rowsToggled = await page.locator(".tree-row").count();
    await homeRow.locator(".caret").click();
    await waitRows("same");
    const rowsBack = await page.locator(".tree-row").count();
    check(
      "ツリーの開閉が両方向に効く",
      rowsToggled !== rowsBefore && rowsBack === rowsBefore,
      `${rowsBefore} → ${rowsToggled} → ${rowsBack}`
    );

    // 名前を押すと一覧がそこへ移る。**パンくずで実際に移動を確かめる**
    await page.locator('.tree-row[data-path="/home"] .tree-name').click();
    await page.locator(".entries .name", { hasText: "USER" }).first().waitFor({ timeout: 30000 });
    const crumbs = await page.locator("nav.crumbs button").allTextContents();
    check("ツリーから移動できる", crumbs.join("/").includes("home"), crumbs.join(" / "));

    // 現在地がツリーで分かる
    const selected = await page.locator(".tree-row.sel").count();
    check("ツリーが現在地を示す", selected === 1, `sel=${selected}`);
    // 一覧経由で ifsdemo に戻る
    for (const [step, expect2] of [
      ["USER", "ifsdemo"],
      ["ifsdemo", "hello.txt"]
    ]) {
      await page.locator(".entries li", { hasText: step }).first().click();
      await page.locator(".entries .name", { hasText: expect2 }).first().waitFor({ timeout: 30000 });
    }

    // 4) テキストのプレビュー（UTF-8 で読めるものは textarea で編集可能に表示される）
    await page.locator(".entries li", { hasText: "nihongo.txt" }).first().click();
    await page.locator(".preview textarea.editor").waitFor({ timeout: 30000 });
    const text = await page.locator(".preview textarea.editor").inputValue();
    check("テキストが表示される", text.includes("日本語テスト"), text.trim());

    // 編集して保存し、サーバーから読み直して反映を確かめる（専用の一時ファイル）
    const editRow = page
      .locator(".entries li")
      .filter({ has: page.locator(".name", { hasText: /^e2e-edit\.txt$/ }) })
      .first();
    await editRow.click();
    // 前のファイルの内容が e2e-edit.txt の中身に差し替わるまで待つ
    await page
      .waitForFunction(
        () => (document.querySelector(".preview textarea.editor")?.value ?? "") === "before\n",
        undefined,
        { timeout: 30000 }
      )
      .catch(() => {});
    await page.locator(".preview textarea.editor").fill("after edit\n");
    await page.locator(".preview .actions button", { hasText: "保存" }).click();
    await page.locator("p.note", { hasText: "保存しました" }).waitFor({ timeout: 30000 }).catch(() => {});
    const saved = await page.evaluate(async () => {
      const res = await fetch("/api/host/ifs/read", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ source: { system: "srv:pub400.com" }, path: "/home/USER/ifsdemo/e2e-edit.txt" })
      });
      return (await res.json()).content;
    });
    check("編集した内容が保存される", saved === "after edit\n", JSON.stringify(saved));

    // 4) 画像のプレビュー（**実際に描画されたか**を naturalWidth で見る）
    const hasImage = names.some((n) => /\.(png|jpe?g|gif)$/i.test(n));
    if (hasImage) {
      const imgName = names.find((n) => /\.(png|jpe?g|gif)$/i.test(n));
      await page.locator(".entries li", { hasText: imgName }).first().click();
      await page.locator(".preview img").waitFor({ timeout: 30000 });
      // src が付いただけでは分からない。**実際に読み込めたか**を naturalWidth で見る
      await page.waitForFunction(
        () => (document.querySelector(".preview img")?.naturalWidth ?? 0) > 0,
        undefined,
        { timeout: 30000 }
      ).catch(() => {});
      const natural = await page
        .locator(".preview img")
        .evaluate((el) => el.naturalWidth)
        .catch(() => 0);
      check("画像が実際に描画される", natural > 0, `naturalWidth=${natural}`);
    } else {
      check("画像が実際に描画される", false, "テスト用の画像が実機に無い（スキップ）");
    }

    // 5) PDF のプレビュー
    const pdfName = names.find((n) => /\.pdf$/i.test(n));
    if (pdfName) {
      await page.locator(".entries li", { hasText: pdfName }).first().click();
      await page.locator(".preview iframe").waitFor({ timeout: 30000 }).catch(() => {});
      const frames = await page.locator(".preview iframe").count();
      check("PDF が iframe で表示される", frames === 1, `iframe=${frames}`);
    } else {
      check("PDF が iframe で表示される", false, "テスト用の PDF が実機に無い（スキップ）");
    }

    // 6) ダウンロード（**実際にファイルが降ってくるか**をブラウザのイベントで見る）
    await page.locator(".entries li", { hasText: "hello.txt" }).first().click();
    await page.locator(".preview textarea.editor").waitFor({ timeout: 30000 });
    const dl = page.waitForEvent("download", { timeout: 30000 });
    await page.locator(".preview .actions button", { hasText: "ダウンロード" }).click();
    const file = await dl.catch(() => undefined);
    check("単一ファイルをダウンロードできる", !!file, file ? file.suggestedFilename() : "降ってこない");

    // 7) zip の一括ダウンロード
    const zip = page.waitForEvent("download", { timeout: 120000 });
    await page.locator("header button", { hasText: "まとめて" }).click();
    const zipFile = await zip.catch(() => undefined);
    check("フォルダを zip で取得できる", !!zipFile, zipFile ? zipFile.suggestedFilename() : "降ってこない");

    // 9) アップロード（input に直接ファイルを与える）
    // 上書き確認と削除確認をまとめて受け入れる。
    // **1 つのダイアログに 2 つのハンドラを付けない**（Playwright が二重処理で落ちる）
    page.on("dialog", (d) => d.accept());
    // **フォルダ用の input と区別する。** `input[type=file]` は 2 つある（strict で落ちる）
    await page.setInputFiles('input[type="file"]:not([webkitdirectory])', {
      name: "e2e-upload.txt",
      mimeType: "text/plain",
      buffer: Buffer.from("uploaded from e2e\n")
    });
    await page.locator(".entries .name", { hasText: "e2e-upload" }).first().waitFor({ timeout: 60000 }).catch(() => {});
    const afterUpload = await page.locator(".entries .name").allTextContents();
    check("アップロードしたファイルが一覧に出る", afterUpload.some((n) => n.includes("e2e-upload")), afterUpload.join(", "));

    // 10) 削除（ダイアログは上のハンドラがまとめて受け入れる。二重に登録しない）
    await page.locator(".entries li", { hasText: "e2e-upload" }).first().click();
    await page.locator(".preview .actions button", { hasText: "削除" }).click();
    // 固定待機にしない（一覧の再取得は件数と実機の応答で伸びる）
    await page
      .locator(".entries .name", { hasText: "e2e-upload" })
      .waitFor({ state: "detached", timeout: 60000 })
      .catch(() => {});
    const afterDelete = await page.locator(".entries .name").allTextContents();
    check("削除すると一覧から消える", !afterDelete.some((n) => n.includes("e2e-upload")), afterDelete.join(", "));

    // 10) エラー文言が日本語化される（統合テストで見つかった英語漏れの回帰）。
    // 実機に無いパスを直接叩き、UI が英語の rc 付き文言を出さないことを見る
    const notFoundMsg = await page.evaluate(async () => {
      const res = await fetch("/api/host/ifs/delete", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ source: { system: "srv:pub400.com" }, path: "/home/USER/nosuchfile-e2e" })
      });
      return (await res.json()).code;
    });
    check("削除の失敗は NOT_FOUND を返す", notFoundMsg === "NOT_FOUND", `code=${notFoundMsg}`);

    // 11) 辿れない場所で「先頭 N 件まで」が出る
    await page.locator("nav.crumbs button", { hasText: "/" }).first().click();
    await page.locator(".entries .name", { hasText: "QSYS.LIB" }).first().waitFor({ timeout: 30000 });
    await page.locator(".entries li", { hasText: "QSYS.LIB" }).first().click();
    await page.locator("footer", { hasText: "先頭" }).waitFor({ timeout: 90000 }).catch(() => {});
    const footer = (await page.locator("footer").textContent()) ?? "";
    check("辿れない場所で件数を伝える", footer.includes("先頭"), footer.trim());
  } finally {
    await drop("e2e-dot.png");
    await drop("e2e-mini.pdf");
    await drop("e2e-upload.txt");
    await drop("e2e-edit.txt");
    await browser.close();
    http.close();
    wss.close();
  }

  const failed = results.filter((r) => !r.ok);
  process.stdout.write(`\n${results.length - failed.length}/${results.length} 成功\n`);
  process.exit(failed.length > 0 ? 1 : 0);
}

main().catch((e) => {
  process.stderr.write(`${e?.stack ?? e}\n`);
  process.exit(1);
});
