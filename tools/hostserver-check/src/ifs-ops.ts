/**
 * 実機の IFS で **リネーム（0x000F）とディレクトリ削除（0x000E）** を確かめる手動チェック。
 *
 * 自動テストにはしない——実機・実アカウントを要するため（他の check と同じ方針）。
 *
 * 使い方:
 *   AS400_USER=xxx AS400_PASSWORD=yyy \
 *     npm run ifs-ops -w @as400web/hostserver-check -- --dir /home/USER/ifsdemo
 *
 * 作業用のフォルダ（既定 `<dir>/opscheck`）を作って一通り試し、**最後に必ず消す**。
 * 確かめるのは「成功する」ことだけでなく、**失敗の戻りコードが意図どおり**であること:
 *
 * - 既存の名前へリネーム → `ALREADY_EXISTS`（黙って上書きしない）
 * - 中身のあるフォルダを rmdir → `NOT_EMPTY`（502 ではない）
 * - フォルダをファイル削除で消そうとする → `ACCESS_DENIED`（種別を取り違えた症状。research F4）
 */
import "./log-init.js";
import { Tn5250Error, As400Error } from "@as400web/base";
import { IfsConnection } from "@as400web/hostserver";

const host = process.env["AS400_HOST"] ?? process.env["PUB400_HOST"] ?? "pub400.com";
const user = process.env["AS400_USER"] ?? process.env["PUB400_USER"];
const password = process.env["AS400_PASSWORD"] ?? process.env["PUB400_PASSWORD"];
const useTls = process.argv.includes("--tls");

function argValue(name: string, fallback: string): string {
  const at = process.argv.indexOf(name);
  return at >= 0 ? (process.argv[at + 1] ?? fallback) : fallback;
}
const dir = argValue("--dir", "/home/USER/ifsdemo").replace(/\/$/, "");
const work = `${dir}/opscheck`;

function fail(message: string): never {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}
if (!user || !password) fail("AS400_USER / AS400_PASSWORD を環境変数で指定してください");

/** 期待どおりに失敗することを確かめる（成功したら、それは想定外） */
async function expectFailure(label: string, expected: string, run: () => Promise<void>): Promise<void> {
  try {
    await run();
    process.stdout.write(`  NG   ${label}: 失敗するはずが成功した\n`);
  } catch (e) {
    const code = e instanceof As400Error ? e.code : "(As400Error ではない)";
    process.stdout.write(`  ${code === expected ? "OK  " : "NG  "} ${label}: ${code}（期待 ${expected}）\n`);
  }
}

async function expectOk(label: string, run: () => Promise<void>): Promise<void> {
  try {
    await run();
    process.stdout.write(`  OK   ${label}\n`);
  } catch (e) {
    process.stdout.write(`  NG   ${label}: ${e instanceof Error ? e.message : String(e)}\n`);
  }
}

async function main(): Promise<void> {
  process.stdout.write(`host=${host} tls=${useTls} work=${work}\n\n`);
  const conn = await IfsConnection.connect({
    host,
    user: user as string,
    password: password as string,
    tls: useTls
  });
  try {
    const write = (path: string, text: string): Promise<void> =>
      conn.writeFile(path, new TextEncoder().encode(text), { create: true });

    process.stdout.write("--- 準備\n");
    await expectOk("mkdir 作業フォルダ", () => conn.makeDirectory(work));
    await expectOk("mkdir 子フォルダ", () => conn.makeDirectory(`${work}/sub`));
    await expectOk("ファイルを 2 つ置く", async () => {
      await write(`${work}/a.txt`, "a");
      await write(`${work}/keep.txt`, "keep");
      await write(`${work}/sub/inner.txt`, "inner");
    });

    process.stdout.write("--- リネーム\n");
    await expectOk("ファイルを改名", () => conn.rename(`${work}/a.txt`, `${work}/b.txt`));
    await expectOk("フォルダを改名", () => conn.rename(`${work}/sub`, `${work}/sub2`));
    await expectFailure("既存の名前へ改名", "ALREADY_EXISTS", () =>
      conn.rename(`${work}/b.txt`, `${work}/keep.txt`)
    );
    await expectFailure("存在しないものを改名", "NOT_FOUND", () =>
      conn.rename(`${work}/nope.txt`, `${work}/x.txt`)
    );

    process.stdout.write("--- 削除\n");
    await expectFailure("中身のあるフォルダを rmdir", "NOT_EMPTY", () => conn.removeDirectory(work));
    await expectFailure("フォルダをファイル削除で消す", "ACCESS_DENIED", () =>
      conn.deleteFile(`${work}/sub2`)
    );
    await expectOk("深い順に消す（中身 → 親）", async () => {
      await conn.deleteFile(`${work}/sub2/inner.txt`);
      await conn.removeDirectory(`${work}/sub2`);
      await conn.deleteFile(`${work}/b.txt`);
      await conn.deleteFile(`${work}/keep.txt`);
      await conn.removeDirectory(work);
    });
    await expectFailure("消えたフォルダをもう一度 rmdir", "NOT_FOUND", () =>
      conn.removeDirectory(work)
    );
  } finally {
    // 途中で失敗して残った場合の後始末（消えていれば失敗するだけ）
    await conn.deleteFile(`${work}/b.txt`).catch(() => undefined);
    await conn.deleteFile(`${work}/keep.txt`).catch(() => undefined);
    await conn.deleteFile(`${work}/sub2/inner.txt`).catch(() => undefined);
    await conn.removeDirectory(`${work}/sub2`).catch(() => undefined);
    await conn.removeDirectory(work).catch(() => undefined);
    conn.close();
  }
}

main().catch((e: unknown) => {
  if (e instanceof Tn5250Error) fail(`失敗しました [${e.code}] ${e.message}`);
  fail(`予期しないエラー: ${String(e)}`);
});
