/**
 * 実機の IFS でディレクトリ一覧を確かめる手動チェック。
 *
 * 自動テストにはしない——実機・実アカウントを要するため（他の check と同じ方針）。
 *
 * 使い方:
 *   AS400_USER=xxx AS400_PASSWORD=yyy \
 *     npm run ifs-list -w @as400web/hostserver-check -- --tls --path /home/USER/ifsdemo
 *
 * `--raw` を付けると受信フレームの hex ダンプも出す。
 * **応答レイアウトを実機で確かめ直すときはこれを使う**——過去に READ 応答で
 * 「宣言テンプレート長からデータ開始位置を求める」実装をして壊した経緯があり、
 * 配置を変えるときは必ず実機のバイトを目で見ること。
 */
import "./log-init.js";
import { IfsConnection, Tn5250Error } from "@as400web/core";

const host = process.env["AS400_HOST"] ?? process.env["PUB400_HOST"] ?? "pub400.com";
const user = process.env["AS400_USER"] ?? process.env["PUB400_USER"];
const password = process.env["AS400_PASSWORD"] ?? process.env["PUB400_PASSWORD"];
const useTls = process.argv.includes("--tls");
const raw = process.argv.includes("--raw");

function argValue(name: string, fallback: string): string {
  const at = process.argv.indexOf(name);
  return at >= 0 ? (process.argv[at + 1] ?? fallback) : fallback;
}
const path = argValue("--path", "/home/USER/ifsdemo");
const dumpBytes = Number(argValue("--dump", "160"));
const maxCountArg = argValue("--max-count", "");

function fail(message: string): never {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}
if (!user || !password) fail("AS400_USER / AS400_PASSWORD を環境変数で指定してください");

/** 16 バイトずつ、オフセット付きの hex ダンプ（右に ASCII 表示を添える） */
function hexDump(bytes: Uint8Array, limit: number): string {
  const n = Math.min(bytes.length, limit);
  const lines: string[] = [];
  for (let i = 0; i < n; i += 16) {
    const row = bytes.subarray(i, Math.min(i + 16, n));
    const hex = [...row].map((b) => b.toString(16).padStart(2, "0")).join(" ");
    const ascii = [...row]
      .map((b) => (b >= 0x20 && b < 0x7f ? String.fromCharCode(b) : "."))
      .join("");
    lines.push(
      `  ${String(i).padStart(4, " ")} (0x${i.toString(16).padStart(3, "0")})  ` +
        `${hex.padEnd(47, " ")}  |${ascii}|`
    );
  }
  if (bytes.length > n) lines.push(`  …(+${bytes.length - n} bytes)`);
  return lines.join("\n");
}

function kind(e: { isDirectory: boolean; isSymlink: boolean }): string {
  if (e.isSymlink) return "symlink";
  return e.isDirectory ? "dir" : "file";
}

async function main(): Promise<void> {
  process.stdout.write(`host=${host} tls=${useTls} path=${path}\n\n`);
  const conn = await IfsConnection.connect({
    host,
    user: user as string,
    password: password as string,
    tls: useTls
  });

  try {
    // --mkdir: ディレクトリ作成を実機で確かめる（0x8001 rc=0 が成功、rc=4 が既存）
    const mkdirPath = argValue("--mkdir", "");
    if (mkdirPath) {
      try {
        await conn.makeDirectory(mkdirPath);
        process.stdout.write(`mkdir OK: ${mkdirPath}\n`);
      } catch (e) {
        process.stdout.write(`mkdir NG: ${e instanceof Error ? e.message : String(e)}\n`);
      }
      // 2 回目は既存エラーになるはず（rc=4 を成功と誤認していないかの確認）
      try {
        await conn.makeDirectory(mkdirPath);
        process.stdout.write(`mkdir(2回目) OK ← 既存なのに成功した。判定が誤っている\n`);
      } catch (e) {
        process.stdout.write(`mkdir(2回目) 期待どおり失敗: ${e instanceof Error ? e.message : String(e)}\n`);
      }
      process.stdout.write("\n");
    }

    let frames = 0;
    const started = Date.now();
    const result = await conn.listFiles(path, {
      ...(maxCountArg ? { maxCount: Number(maxCountArg) } : {}),
      ...(raw
        ? {
            onRawFrame: (frame: Uint8Array) => {
              frames++;
              const v = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);
              process.stdout.write(
                `--- frame #${frames} len=${frame.length} ` +
                  `reqrep=0x${v.getUint16(18).toString(16).padStart(4, "0")} ` +
                  `declaredTemplateLength=${v.getUint16(16)} ` +
                  `chain=0x${v.getUint16(20).toString(16).padStart(4, "0")}\n`
              );
              process.stdout.write(`${hexDump(frame, dumpBytes)}\n`);
            }
          }
        : {})
    });
    const elapsed = Date.now() - started;

    for (const e of result.entries) {
      const when = new Date(e.modifiedAt).toISOString().replace("T", " ").slice(0, 19);
      process.stdout.write(
        `${kind(e).padEnd(8)} ${String(e.size).padStart(10)}  ${when}  ` +
          `restart=${String(e.restartId).padStart(4)}  ${e.name}\n`
      );
    }
    const more = result.hasMore
      ? result.canContinue
        ? `（続きあり restart=${result.nextRestartId}）`
        : "（続きあり・ただしこの場所は継続不可）"
      : "";
    process.stdout.write(`\n${result.entries.length} 件${more} / ${elapsed}ms\n`);
    if (raw) process.stdout.write(`frames total = ${frames}\n`);

    // --page: 続きがある限り追いかけて、ページングが最後まで回ることを確かめる
    if (process.argv.includes("--page")) {
      let next = result.nextRestartId;
      let canGo = result.canContinue;
      let page = 1;
      let total = result.entries.length;
      if (result.hasMore && !canGo) {
        process.stdout.write("続きはあるが、この場所では継続できない（Restart ID が進まない）\n");
      }
      while (canGo && next !== undefined && page < 50) {
        page++;
        const r = await conn.listFiles(path, {
          ...(maxCountArg ? { maxCount: Number(maxCountArg) } : {}),
          restartId: next
        });
        total += r.entries.length;
        process.stdout.write(
          `page ${page}: ${r.entries.length} 件 [${r.entries.map((e) => e.name).join(", ")}]` +
            `${r.canContinue ? ` → 続き restart=${r.nextRestartId}` : " → 終わり"}\n`
        );
        canGo = r.canContinue;
        next = r.nextRestartId;
      }
      process.stdout.write(`ページング合計 ${total} 件 / ${page} ページ\n`);
    }
  } finally {
    conn.close();
  }
}

main().catch((e: unknown) => {
  if (e instanceof Tn5250Error) fail(`失敗しました [${e.code}] ${e.message}`);
  fail(`予期しないエラー: ${String(e)}`);
});
