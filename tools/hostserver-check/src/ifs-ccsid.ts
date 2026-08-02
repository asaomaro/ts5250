/**
 * 実機の IFS で「ファイル内容の CCSID タグ」が取れるかを確かめる手動チェック。
 *
 * 自動テストにはしない——実機・実アカウントを要するため（他の check と同じ方針）。
 *
 * 使い方:
 *   AS400_USER=xxx AS400_PASSWORD=yyy \
 *     npm run ifs-ccsid -w @ts5250/hostserver-check -- --dir /home/USER
 *   （`--roundtrip` を付けると EBCDIC ファイルを作って復号・往復まで確かめ、最後に消す）
 *
 * 見るところ:
 *
 * - サーバーが報告する**データストリームレベル**（OA2 の CCSID をどのオフセットで読むかが変わる。
 *   PUB400 は要求 8 に対して 24 を返す）
 * - ディレクトリ内の各ファイルのタグと、決定表がどう判断するか（中身 / タグ / 復号できず）
 *
 * research のスパイクを、繰り返し使える形にしたもの（research F2〜F6）。
 */
import "./log-init.js";
import { As400Error } from "@ts5250/base";
import { canDecodeCcsid, decodeCcsidText, encodeCcsidText } from "@ts5250/ebcdic";
import { IfsConnection } from "@ts5250/hostserver";

const host = process.env["AS400_HOST"] ?? process.env["PUB400_HOST"] ?? "pub400.com";
const user = process.env["AS400_USER"] ?? process.env["PUB400_USER"];
const password = process.env["AS400_PASSWORD"] ?? process.env["PUB400_PASSWORD"];
const useTls = process.argv.includes("--tls");
const roundtrip = process.argv.includes("--roundtrip");

function argValue(name: string, fallback: string): string {
  const at = process.argv.indexOf(name);
  return at >= 0 ? (process.argv[at + 1] ?? fallback) : fallback;
}
const dir = argValue("--dir", "/home/USER").replace(/\/$/, "");
const maxFiles = Number(argValue("--max", "20"));

function fail(message: string): never {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}
if (!user || !password) fail("AS400_USER / AS400_PASSWORD を環境変数で指定してください");

/** 決定表と同じ順序で「何として読めるか」を一言にする（サーバーの ifs-text.ts と同じ判断） */
function verdict(data: Uint8Array, ccsid: number | undefined): string {
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(data);
    return "中身から UTF-8 と判定";
  } catch {
    // UTF-8 ではなかった
  }
  if (ccsid !== undefined && ccsid !== 0 && ccsid !== 65535 && canDecodeCcsid(ccsid)) {
    try {
      const { text, newline } = decodeCcsidText(ccsid, data);
      const head = text.slice(0, 20).replace(/\n/g, "\\n");
      return `タグ ${ccsid} で復号（行末 ${newline}）: ${head}`;
    } catch {
      return `タグ ${ccsid} では読めなかった`;
    }
  }
  return "復号できず（手動選択かダウンロード）";
}

async function main(): Promise<void> {
  process.stdout.write(`host=${host} tls=${useTls} dir=${dir}\n`);
  const conn = await IfsConnection.connect({
    host,
    user: user as string,
    password: password as string,
    tls: useTls
  });
  try {
    // **要求値（8）ではなくサーバーの報告値**。OA2 の読み位置がこれで決まる
    process.stdout.write(`サーバー報告 datastreamLevel = ${conn.datastreamLevel}\n\n`);

    const listed = await conn.listFiles(dir, { maxCount: 0xffff });
    let shown = 0;
    for (const e of listed.entries) {
      if (e.isDirectory || shown >= maxFiles) continue;
      shown++;
      const path = `${dir}/${e.name}`;
      try {
        const file = await conn.readTextFile(path);
        process.stdout.write(
          `${String(file.ccsid ?? "-").padStart(6)}  ${String(file.data.length).padStart(9)}  ` +
            `${e.name}\n          → ${verdict(file.data, file.ccsid)}\n`
        );
      } catch (err) {
        // 権限が無い・ストリームファイルでない等。**現状でも読めない対象**なので退行ではない
        process.stdout.write(`${"".padStart(6)}  ${"".padStart(9)}  ${e.name}\n          → ${String(err)}\n`);
      }
    }
    process.stdout.write(`\n${shown} ファイル（--max ${maxFiles}）\n`);

    if (roundtrip) {
      process.stdout.write("\n--- EBCDIC の往復（作成 → タグ → 復号 → 削除）\n");
      for (const ccsid of [1399, 273, 37]) {
        const path = `${dir}/ccsidcheck-${ccsid}.txt`;
        const text = ccsid === 1399 ? "日本語テスト@abc\n" : "hello@world\n";
        const { bytes } = encodeCcsidText(ccsid, text);
        try {
          await conn.writeFile(path, bytes, { create: true, dataCcsid: ccsid });
          const read = await conn.readTextFile(path);
          const decoded = read.ccsid !== undefined ? decodeCcsidText(read.ccsid, read.data).text : "";
          process.stdout.write(
            `  CCSID ${ccsid}: タグ=${read.ccsid} 一致=${decoded === text ? "はい" : "いいえ"}\n`
          );
        } finally {
          await conn.deleteFile(path).catch(() => undefined);
        }
      }
    }
  } finally {
    conn.close();
  }
}

main().catch((e: unknown) => {
  if (e instanceof As400Error) fail(`失敗しました [${e.code}] ${e.message}`);
  fail(`予期しないエラー: ${String(e)}`);
});
