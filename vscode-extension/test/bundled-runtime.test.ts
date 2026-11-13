import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import { zipSync } from "fflate";
import { fileURLToPath } from "node:url";
const script = fileURLToPath(new URL("../scripts/prepare-runtime.mjs", import.meta.url));
const runtime = await import(script);

/** tar 内の任意の名前を展開先として使わないことも確認するための小さな配布物。 */
function tar(files: Record<string, string>): Buffer {
  const chunks: Buffer[] = [];
  for (const [name, value] of Object.entries(files)) {
    const data = Buffer.from(value);
    const header = Buffer.alloc(512);
    header.write(name); header.write(data.length.toString(8).padStart(11, "0"), 124); header[156] = 48;
    chunks.push(header, data, Buffer.alloc((512 - data.length % 512) % 512));
  }
  return gzipSync(Buffer.concat([...chunks, Buffer.alloc(1024)]));
}

describe("同梱 Node 配布物", () => {
  it("6つのVSIX対象を固定チェックサムで扱い、未対応OSで取得しない", async () => {
    expect(Object.keys(runtime.ARTIFACTS).sort()).toEqual(["darwin-arm64", "darwin-x64", "linux-arm64", "linux-x64", "win32-arm64", "win32-x64"]);
    await expect(runtime.prepareRuntime({ target: "alpine-x64" })).rejects.toThrow(/対応していない/);
    for (const target of ["../../elsewhere", "__proto__", "toString"]) await expect(runtime.prepareRuntime({ target })).rejects.toThrow(/対応していない/);
  });
  it("アーカイブの破損を拒否する", () => {
    const data = Buffer.from("official fixture");
    const hash = createHash("sha256").update(data).digest("hex");
    expect(runtime.verifyArchive(data, hash)).toBe(data);
    expect(() => runtime.verifyArchive(Buffer.from("changed"), hash)).toThrow(/SHA-256/);
  });
  it("Unix tarから実行ファイルとライセンスだけ取り出す", () => {
    const filename = "node-v26.13.1-linux-x64.tar.gz";
    const prefix = filename.replace(".tar.gz", "");
    const result = runtime.extractRuntime(tar({ [`${prefix}/bin/node`]: "ELF fixture", [`${prefix}/LICENSE`]: "license", "../../outside": "unwanted" }), filename);
    expect(result.binary.toString()).toBe("ELF fixture");
    expect(result.license.toString()).toBe("license");
    expect(() => runtime.extractRuntime(tar({ [`${prefix}/bin/node`]: "ELF fixture" }), filename)).toThrow(/ライセンス/);
    expect(() => runtime.extractRuntime(Buffer.from("broken gzip"), filename)).toThrow();
  });
  it("Windows zipでもnode.exeとライセンスを同じ構成へ取り出す", () => {
    const filename = "node-v26.13.1-win-arm64.zip";
    const prefix = filename.replace(".zip", "");
    const result = runtime.extractRuntime(zipSync({ [`${prefix}/node.exe`]: Buffer.from("MZ fixture"), [`${prefix}/LICENSE`]: Buffer.from("license"), "../../outside": Buffer.from("unwanted") }), filename);
    expect(result.binary.toString()).toBe("MZ fixture");
    expect(result.license.toString()).toBe("license");
    expect(() => runtime.extractRuntime(zipSync({}), filename)).toThrow(/ライセンス/);
  });
});


it("VSIX の Node・ライセンスの欠落や対象 OS の食い違いを検出する", async () => {
  const verifyScript = fileURLToPath(new URL("../scripts/verify-package.mjs", import.meta.url));
  const { verifyPackage } = await import(verifyScript);
  const binary = Buffer.from("runtime fixture");
  const files: Record<string, Uint8Array> = {
    "extension/server-stage/runtime/node": binary,
    "extension/server-stage/runtime/LICENSE": Buffer.from("license"),
    "extension/server-stage/runtime/runtime.json": Buffer.from(JSON.stringify({ target: "linux-x64", binarySha256: createHash("sha256").update(binary).digest("hex") })),
    "extension.vsixmanifest": Buffer.from('<Identity TargetPlatform="linux-x64"/>')
  };
  expect(() => verifyPackage(zipSync(files), "linux-x64")).not.toThrow();
  expect(() => verifyPackage(zipSync(files), "darwin-x64")).toThrow(/OS/);
  for (const name of ["node", "LICENSE"]) {
    const copy = { ...files }; delete copy[`extension/server-stage/runtime/${name}`];
    expect(() => verifyPackage(zipSync(copy), "linux-x64")).toThrow();
  }
  expect(() => verifyPackage(zipSync({ ...files, "extension/server-stage/runtime/node": Buffer.from("damaged") }), "linux-x64")).toThrow(/破損/);
});
