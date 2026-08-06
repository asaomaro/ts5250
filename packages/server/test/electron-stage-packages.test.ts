import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * **配布物に入れる自前パッケージは、依存の宣言から導く。**
 *
 * `electron/scripts/prepare-app.mjs` はかつて `["ebcdic", "scs", "core", "server"]` と
 * 書き写していた。`core` → `tn5250` の改名（`20260801-library-extraction-tn5250`）と
 * `base` / `hostserver` の追加に追随できず、`electron.sh --build` が
 * **「ビルド成果物がありません: packages/core/dist」で止まっていた**。
 *
 * **型検査でもテストでも捕まらない種類の壊れ方**（配布物だけが古くなる。動かして初めて分かる）
 * なので、ここで塞ぐ。検査するのは 2 点:
 *
 * 1. 一覧を**手で並べていない**こと（`package.json` の依存から辿ること）
 * 2. 辿った結果が、実際に存在するパッケージと一致すること
 */

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = join(here, "..", "..", "..");
const SCRIPT = join(ROOT, "electron", "scripts", "prepare-app.mjs");

/** `prepare-app.mjs` と同じ辿り方（入口から `@ts5250/*` の依存を再帰的に集める） */
function collect(entry: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const visit = (name: string): void => {
    if (seen.has(name)) return;
    seen.add(name);
    const pkg = JSON.parse(readFileSync(join(ROOT, "packages", name, "package.json"), "utf8"));
    for (const dep of Object.keys(pkg.dependencies ?? {})) {
      if (dep.startsWith("@ts5250/")) visit(dep.slice("@ts5250/".length));
    }
    out.push(name);
  };
  visit(entry);
  return out;
}

describe("electron の配布物に入る自前パッケージ", () => {
  const src = readFileSync(SCRIPT, "utf8");

  it("一覧を手で並べていない（依存の宣言から辿る）", () => {
    // `const LIB_PACKAGES = ["…", "…"]` のようなベタ書きを禁じる
    expect(src, "LIB_PACKAGES がベタ書きされている").not.toMatch(
      /const LIB_PACKAGES\s*=\s*\[\s*"/
    );
    expect(src).toMatch(/const LIB_PACKAGES\s*=\s*collectLibPackages\(/);
  });

  it("辿った先のパッケージがすべて実在する", () => {
    const libs = collect("server");
    for (const name of libs) {
      expect(existsSync(join(ROOT, "packages", name)), `packages/${name} が無い`).toBe(true);
    }
    // 依存が先・利用側が後（server は最後）
    expect(libs[libs.length - 1]).toBe("server");
  });

  it("いま切り出してあるライブラリを取りこぼさない", () => {
    // 改名・追加でここが変わったら、配布物側も自動で追随していることの確認
    expect(collect("server").sort()).toEqual(
      ["base", "ebcdic", "hostserver", "scs", "server", "tn5250"].sort()
    );
  });

  it("web-ui は混ぜない（配信されるだけで node_modules へは入れない）", () => {
    expect(collect("server")).not.toContain("web-ui");
    // 静的アセットは別経路でコピーする
    expect(src).toMatch(/packages", "web-ui", "dist"/);
  });
});
