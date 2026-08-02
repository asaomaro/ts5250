/**
 * 実機の IFS に対して、複数ブロック（DEFAULT_CHUNK=32768 超）の読み書きが
 * 往復するかを確かめる手動チェック。
 *
 * 自動テストにはしない——実機・実アカウントを要するため（他の check と同じ方針）。
 *
 * 使い方:
 *   AS400_USER=xxx AS400_PASSWORD=yyy \
 *     npm run ifs -w @ts5250/hostserver-check -- --tls --dir /home/USER
 *
 * 検証内容: 決定的な擬似乱数バイト列を書き、読み戻して長さと SHA-256 を比較する。
 * 境界（32767 / 32768 / 32769）を含めるのは、チャンク境界での取りこぼしを見つけるため。
 */
import "./log-init.js";
import { createHash } from "node:crypto";
import { As400Error } from "@ts5250/base";
import { IfsConnection } from "@ts5250/hostserver";

const host = process.env["AS400_HOST"] ?? process.env["PUB400_HOST"] ?? "pub400.com";
const user = process.env["AS400_USER"] ?? process.env["PUB400_USER"];
const password = process.env["AS400_PASSWORD"] ?? process.env["PUB400_PASSWORD"];
const useTls = process.argv.includes("--tls");
const keep = process.argv.includes("--keep");

function argValue(name: string, fallback: string): string {
  const at = process.argv.indexOf(name);
  return at >= 0 ? (process.argv[at + 1] ?? fallback) : fallback;
}
const dir = argValue("--dir", "/home/USER").replace(/\/$/, "");

function fail(message: string): never {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}
if (!user || !password) fail("AS400_USER / AS400_PASSWORD を環境変数で指定してください");

/** 決定的な擬似乱数（seed 固定の xorshift）。同じ長さなら常に同じ内容になる */
function makeBytes(length: number): Uint8Array {
  const out = new Uint8Array(length);
  let state = 0x9e3779b9 ^ length;
  for (let i = 0; i < length; i++) {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    out[i] = (state >>> 24) & 0xff;
  }
  return out;
}

function sha256(data: Uint8Array): string {
  return createHash("sha256").update(data).digest("hex").slice(0, 16);
}

/** 先頭から何バイト目で食い違うか。一致していれば -1 */
function firstDiff(a: Uint8Array, b: Uint8Array): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) return i;
  return a.length === b.length ? -1 : n;
}

const DEFAULT_SIZES = [1024, 32767, 32768, 32769, 100_000, 300_000];
const SIZES = argValue("--sizes", "")
  ? argValue("--sizes", "")
      .split(",")
      .map((s) => Number(s.trim()))
      .filter((n) => Number.isFinite(n) && n > 0)
  : DEFAULT_SIZES;

async function main(): Promise<void> {
  process.stdout.write(`host=${host} tls=${useTls} dir=${dir}\n\n`);
  const conn = await IfsConnection.connect({
    host,
    user: user as string,
    password: password as string,
    tls: useTls
  });

  const rows: string[] = [];
  let failures = 0;
  try {
    for (const size of SIZES) {
      const path = `${dir}/ifs-mbtest-${size}.bin`;
      const sent = makeBytes(size);
      let verdict: string;
      try {
        const wroteAt = Date.now();
        await conn.writeFile(path, sent, { create: true });
        const wroteMs = Date.now() - wroteAt;

        const readAt = Date.now();
        const got = await conn.readFile(path);
        const readMs = Date.now() - readAt;

        const diff = firstDiff(sent, got);
        const ok = diff === -1;
        if (!ok) failures++;
        verdict =
          `${ok ? "OK  " : "NG  "} size=${size} read=${got.length} ` +
          `sha(sent)=${sha256(sent)} sha(got)=${sha256(got)} ` +
          `w=${wroteMs}ms r=${readMs}ms` +
          (ok ? "" : ` firstDiff=${diff}`);
      } catch (e) {
        failures++;
        verdict = `ERR size=${size} ${e instanceof As400Error ? `[${e.code}] ${e.message}` : String(e)}`;
      }
      process.stdout.write(`${verdict}\n`);
      rows.push(verdict);

      if (!keep) {
        try {
          await conn.deleteFile(path);
        } catch {
          process.stdout.write(`     (削除できず: ${path})\n`);
        }
      }
    }
  } finally {
    conn.close();
  }

  process.stdout.write(`\n${failures === 0 ? "全て一致" : `${failures} 件が不一致`}\n`);
  if (failures > 0) process.exit(2);
}

main().catch((e: unknown) => {
  if (e instanceof As400Error) fail(`失敗しました [${e.code}] ${e.message}`);
  fail(`予期しないエラー: ${String(e)}`);
});
