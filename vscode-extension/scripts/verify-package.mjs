import { unzipSync } from "fflate";
import { createHash } from "node:crypto";

/** stage の成功だけでは不足する。VSIX の除外設定で実行ファイル・ライセンスが落ちていないか検査する。 */
export function verifyPackage(bytes, target) {
  const base = "extension/server-stage/runtime/";
  const executable = target.startsWith("win32-") ? "node.exe" : "node";
  const wanted = new Set([`${base}${executable}`, `${base}runtime.json`, `${base}LICENSE`, "extension.vsixmanifest"]);
  const entries = unzipSync(bytes, { filter: (entry) => wanted.has(entry.name) });
  const text = (name) => Buffer.from(entries[name] ?? []).toString("utf8");
  const metadata = JSON.parse(text(`${base}runtime.json`));
  if (metadata.target !== target || !text("extension.vsixmanifest").includes(`TargetPlatform="${target}"`)) throw new Error("VSIX と同梱 Node の OS/CPU が一致しません");
  if (!entries[`${base}${executable}`]?.length || createHash("sha256").update(entries[`${base}${executable}`]).digest("hex") !== metadata.binarySha256) throw new Error("VSIX の Node 実行ファイルがありません、または破損しています");
  if (!entries[`${base}LICENSE`]?.length) throw new Error("VSIX に Node のライセンスがありません");
}
