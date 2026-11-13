/**
 * OS 別 VSIX に Node を実体同梱する。利用者の PATH・ネット接続・VSCode 内蔵 Node に依存しない。
 * 公式 v26.13.1/SHASUMS256.txt の固定値でアーカイブを検証してから、必要な2ファイルだけ取り出す。
 */
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync, existsSync, chmodSync, rmSync, renameSync, mkdtempSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";
import { unzipSync } from "fflate";

export const NODE_VERSION = "26.13.1";
export const ARTIFACTS = {
  "linux-x64": ["linux-x64.tar.gz", "518674de2b621728a5e4486f5fb3b7d2900bb3cc4aa97969edaa463db99f9778"],
  "linux-arm64": ["linux-arm64.tar.gz", "80a330b35415382878df18d41afbd106ea89bfb3be0087d6608e289a14c5cc7d"],
  "darwin-x64": ["darwin-x64.tar.gz", "82bb96078a24ca50b9c9a38f2379e6be6d87171fcd400fc14c8934b3bce96e2f"],
  "darwin-arm64": ["darwin-arm64.tar.gz", "aec2514ea1ceb2ba52455e9ec65986f6749a06dd759e5db2a72e6889668c9735"],
  "win32-x64": ["win-x64.zip", "e2edda75bfb089654705cf65a13b58933bfd5f57148e8ebda916f58a2474f1f7"],
  "win32-arm64": ["win-arm64.zip", "181ebe431b90787113a9e4fc80d38ce86d37888a353a0386de44d2872e48cb97"]
};
const EXT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** 入力・キャッシュとも同じ検査を通す。破損キャッシュを信用して配布しない。 */
export function verifyArchive(bytes, expected) {
  if (createHash("sha256").update(bytes).digest("hex") !== expected) throw new Error("Node.js 配布物の SHA-256 が一致しません");
  return bytes;
}

/** tar のパスをファイルシステムへ展開せず、固定された二つの通常ファイルだけを拾う。 */
export function extractRuntime(bytes, filename) {
  const top = filename.replace(/\.(tar\.gz|zip)$/, "");
  const windows = filename.endsWith(".zip");
  const executable = windows ? "node.exe" : "bin/node";
  const wanted = new Set([`${top}/${executable}`, `${top}/LICENSE`]);
  const files = new Map();
  if (windows) {
    for (const [name, data] of Object.entries(unzipSync(bytes, { filter: (entry) => wanted.has(entry.name) }))) files.set(name, Buffer.from(data));
  } else {
    const tar = gunzipSync(bytes);
    let offset = 0;
    while (offset + 512 <= tar.length) {
      const header = tar.subarray(offset, offset + 512);
      if (header.every((b) => b === 0)) break;
      const string = (start, length) => header.subarray(start, start + length).toString("utf8").split("\0")[0];
      const prefix = string(345, 155);
      const name = (prefix ? `${prefix}/` : "") + string(0, 100);
      const size = Number.parseInt(string(124, 12).trim(), 8);
      if (!Number.isSafeInteger(size) || size < 0 || offset + 512 + size > tar.length) throw new Error("Node.js tar のサイズが不正です");
      if (wanted.has(name)) {
        if ((header[156] !== 0 && header[156] !== 48) || files.has(name)) throw new Error("Node.js tar の実行ファイル形式が不正です");
        files.set(name, Buffer.from(tar.subarray(offset + 512, offset + 512 + size)));
      }
      offset += 512 + Math.ceil(size / 512) * 512;
    }
  }
  if (!files.get(`${top}/${executable}`)?.length || !files.get(`${top}/LICENSE`)?.length) throw new Error("Node.js の実行ファイルまたはライセンスがありません");
  return { binary: files.get(`${top}/${executable}`), license: files.get(`${top}/LICENSE`) };
}

/** 取得・整合性検査・展開がすべて成功してから stage を置き換える。 */
export async function prepareRuntime({ target = `${process.platform}-${process.arch}`, stage = join(EXT_DIR, "server-stage"), cache = join(EXT_DIR, ".node-cache") } = {}) {
  const artifact = Object.hasOwn(ARTIFACTS, target) ? ARTIFACTS[target] : undefined;
  if (!artifact) throw new Error(`対応していない VSIX ターゲットです: ${target}（${Object.keys(ARTIFACTS).join(", ")}）`);
  const [suffix, archiveSha256] = artifact;
  const filename = `node-v${NODE_VERSION}-${suffix}`;
  mkdirSync(cache, { recursive: true });
  const cached = join(cache, filename);
  let bytes;
  if (existsSync(cached)) bytes = verifyArchive(readFileSync(cached), archiveSha256);
  else {
    const response = await fetch(`https://nodejs.org/dist/v${NODE_VERSION}/${filename}`, { signal: AbortSignal.timeout(120000) });
    if (!response.ok) throw new Error(`Node.js の取得に失敗しました（HTTP ${response.status}）`);
    bytes = verifyArchive(Buffer.from(await response.arrayBuffer()), archiveSha256);
    writeFileSync(cached, bytes);
  }
  const { binary, license } = extractRuntime(bytes, filename);
  mkdirSync(stage, { recursive: true });
  const temp = mkdtempSync(join(stage, ".runtime-"));
  try {
    const executable = target.startsWith("win32-") ? "node.exe" : "node";
    writeFileSync(join(temp, executable), binary);
    if (executable === "node") chmodSync(join(temp, executable), 0o755);
    writeFileSync(join(temp, "LICENSE"), license);
    writeFileSync(join(temp, "runtime.json"), JSON.stringify({ version: NODE_VERSION, target, archiveSha256, binarySha256: createHash("sha256").update(binary).digest("hex") }, null, 2) + "\n");
    rmSync(join(stage, "runtime"), { recursive: true, force: true });
    renameSync(temp, join(stage, "runtime"));
  } finally { rmSync(temp, { recursive: true, force: true }); }
  process.stderr.write(`同梱 Node.js ${NODE_VERSION}: ${target}\n`);
  return target;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await prepareRuntime({ ...(process.argv[2] ? { target: process.argv[2] } : {}) });
}
