import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * **同梱している Windows 版 DLL が、いまのソースから作られたものであること。**
 *
 * ## なぜ検査が要るのか
 *
 * Rust の入っていない環境の利用者のために、`crates/hllapi/prebuilt/` へ DLL を入れている。
 * ビルド済みのものをリポジトリに置くと、**ソースを変えて作り直し忘れたときに、
 * 黙って古い DLL が配られる**——しかも利用者側では気づきようがない。
 *
 * `manifest.json` にソース木の指紋を残してあるので、ここで突き合わせる。
 * 食い違ったら `crates/hllapi/tools/update-prebuilt.sh` を実行すること。
 *
 * ## 指紋の取り方
 *
 * `src/**\/*.rs` ＋ `Cargo.toml` ＋ `Cargo.lock` の**相対パスと中身**を順に流し込んだ sha256。
 * パスも混ぜるのは、ファイルの入れ替えや改名を取りこぼさないため。
 */

const CRATE = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "crates", "hllapi");

interface Manifest {
  source: { sha256: string; files: string[] };
  binaries: Record<string, { path: string; sha256: string; bytes: number }>;
}

const manifest = (): Manifest =>
  JSON.parse(readFileSync(join(CRATE, "prebuilt", "manifest.json"), "utf8")) as Manifest;

/** `prebuilt-manifest.py` と**同じ規則**で指紋を取る（片方だけ変えると検査が意味を失う） */
function sourceHash(files: string[]): string {
  const h = createHash("sha256");
  for (const rel of files) {
    h.update(rel);
    h.update(readFileSync(join(CRATE, rel)));
  }
  return h.digest("hex");
}

describe("同梱した Windows 版 DLL", () => {
  const m = manifest();

  it("**ソースを変えたら作り直されている**（古い DLL が黙って配られない）", () => {
    expect(sourceHash(m.source.files)).toBe(m.source.sha256);
  });

  it("**指紋の対象にソースが漏れていない**", () => {
    // `src/*.rs` が増えたのに manifest の files に入っていない、を捕まえる
    const listed = new Set(m.source.files);
    for (const f of ["Cargo.toml", "Cargo.lock", "src/lib.rs", "src/http.rs", "src/json.rs", "src/b64.rs"]) {
      expect(listed).toContain(f);
    }
  });

  it("**DLL が中身どおり**（差し替えられていない）", () => {
    for (const [arch, b] of Object.entries(m.binaries)) {
      const bytes = readFileSync(join(CRATE, b.path));
      expect(bytes.length, arch).toBe(b.bytes);
      expect(createHash("sha256").update(bytes).digest("hex"), arch).toBe(b.sha256);
    }
  });

  it("**64bit と 32bit の両方がある**（Office のビット数に合わせる必要がある）", () => {
    expect(Object.keys(m.binaries).sort()).toEqual(["x64", "x86"]);
    for (const b of Object.values(m.binaries)) {
      expect(existsSync(join(CRATE, b.path))).toBe(true);
    }
  });

  it("**PE で、32bit は stdcall**（VBA の Declare から呼べる形）", () => {
    // 詳しい検査は `tools/check-dll.py`。ここは最低限——PE であることと、
    // 32bit の `hllapi` が `ret 0x10`（引数を呼ばれた側が片付ける）であること
    for (const [arch, b] of Object.entries(m.binaries)) {
      const d = readFileSync(join(CRATE, b.path));
      expect(d.subarray(0, 2).toString("latin1"), arch).toBe("MZ");
      const pe = d.readUInt32LE(0x3c);
      expect(d.subarray(pe, pe + 4).toString("latin1"), arch).toBe("PE\0\0");
      const machine = d.readUInt16LE(pe + 4);
      expect(machine, arch).toBe(arch === "x64" ? 0x8664 : 0x14c);
    }
  });
});
