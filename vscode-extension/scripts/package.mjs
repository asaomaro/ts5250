/** Node の対象 OS と VSIX メタデータを必ず同じ引数から作る。誤った OS の実行ファイルを配らない。 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { verifyPackage } from "./verify-package.mjs";
import { ARTIFACTS, prepareRuntime } from "./prepare-runtime.mjs";
const ext = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const vsce = require.resolve("@vscode/vsce/vsce");
const args = process.argv.slice(2);
let targets;
if (args.length === 0) targets = [`${process.platform}-${process.arch}`];
else if (args.length === 1 && args[0] === "--all") targets = Object.keys(ARTIFACTS);
else if (args.length === 2 && args[0] === "--target") targets = [args[1]];
else throw new Error("使い方: npm run package -- [--all | --target linux-x64]");
for (const target of targets) {
  await prepareRuntime({ target });
  const version = JSON.parse(readFileSync(join(ext, "package.json"), "utf8")).version;
  const output = join(ext, `ts5250-vscode-${target}-${version}.vsix`);
  execFileSync(process.execPath, [vsce, "package", "--target", target, "--out", output], { cwd: ext, stdio: "inherit" });
  verifyPackage(readFileSync(output), target);
}
