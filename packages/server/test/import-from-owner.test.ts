import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * **使うものは在り処から取る。** `@ts5250/tn5250` を「何でも入っている袋」として使わない。
 *
 * 経緯: ホストサーバー層を `@ts5250/hostserver` へ切り出したあと（PR #233）も、
 * server は後方互換の再輸出を通じて `@ts5250/tn5250` から `DbConnection` や `As400Error` を
 * 取り続けていた。`20260801-library-extraction-drop-core-reexport` で 58 ファイル・61 文を
 * 直参照へ移し、core 側の再輸出を撤去した。
 *
 * **このテストが要る理由**: 撤去した今なら間違えれば型エラーになるが、`As400Error` のように
 * **core が今も再輸出している名前**（`@ts5250/base` 由来）は `@ts5250/tn5250` から
 * 取っても通ってしまう。通るが、出どころが見えなくなる。人の注意ではなく機械で塞ぐ。
 *
 * **列挙ではなく走査**にしてある——ファイル名を並べると、後から足されたファイルが素通りする。
 */

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = join(here, "..", "..", "..");

const strip = (s: string): string => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");

/** そのパッケージのバレルが出す名前（別名適用後） */
function exportedNames(pkg: string): Set<string> {
  const src = readFileSync(join(ROOT, "packages", pkg, "src", "index.ts"), "utf8");
  const out = new Set<string>();
  for (const m of src.matchAll(/export\s+(?:type\s+)?\{([^}]*)\}\s*from/g)) {
    for (const raw of m[1]!.split(",")) {
      const item = strip(raw).trim();
      if (!item) continue;
      const alias = /\bas\s+([A-Za-z_$][\w$]*)\s*$/.exec(item);
      out.add(alias ? alias[1]! : item.replace(/^type\s+/, "").trim());
    }
  }
  return out;
}

function collect(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const f = join(dir, e.name);
    if (e.isDirectory()) out.push(...collect(f));
    else if (e.name.endsWith(".ts")) out.push(f);
  }
  return out;
}

/** `@ts5250/tn5250` から取っている名前を、実体のあるパッケージ名つきで返す */
function misplacedImports(dirs: readonly string[]): string[] {
  // **表を手で持たない。** 各パッケージのバレルから読む——手で書き写すと、
  // 出どころが移ったときに検査だけが古いままになる
  const owners: [string, Set<string>][] = [
    ["@ts5250/base", exportedNames("base")],
    ["@ts5250/hostserver", exportedNames("hostserver")]
  ];
  const bad: string[] = [];
  for (const dir of dirs) {
    for (const f of collect(join(ROOT, dir))) {
      const src = readFileSync(f, "utf8");
      for (const m of src.matchAll(
        /import\s+(?:type\s+)?\{([^}]*)\}\s*from\s+["']@ts5250\/core["']/g
      )) {
        for (const raw of m[1]!.split(",")) {
          const item = strip(raw).trim();
          if (!item) continue;
          const orig = item.replace(/^type\s+/, "").split(/\s+as\s+/)[0]!.trim();
          const owner = owners.find(([, names]) => names.has(orig));
          if (owner) bad.push(`${relative(ROOT, f)}: ${orig} は ${owner[0]} のもの`);
        }
      }
    }
  }
  return bad;
}

const DIRS = ["packages/server/src", "packages/server/test", "tools/hostserver-check/src"];

describe("import は実体のあるパッケージから取る", () => {
  it("走査対象を実際に拾えている（空振りで緑にならないこと）", () => {
    const files = DIRS.flatMap((d) => collect(join(ROOT, d)));
    expect(files.length).toBeGreaterThan(50);
    // 基準となる名前表が空でないことも確かめる（空なら何も検出しない）
    expect(exportedNames("base").size).toBeGreaterThan(5);
    expect(exportedNames("hostserver").size).toBeGreaterThan(30);
  });

  it("base / hostserver のものを @ts5250/tn5250 から取っている箇所が無い", () => {
    expect(misplacedImports(DIRS)).toEqual([]);
  });

  it("使っているパッケージを package.json で宣言している", () => {
    // monorepo では宣言しなくても hoisting で動いてしまうので、宣言そのものを検査する
    for (const [pkgPath, dirs] of [
      ["packages/server", ["packages/server/src", "packages/server/test"]],
      ["tools/hostserver-check", ["tools/hostserver-check/src"]]
    ] as const) {
      const deps = Object.keys(
        (
          JSON.parse(readFileSync(join(ROOT, pkgPath, "package.json"), "utf8")) as {
            dependencies: Record<string, string>;
          }
        ).dependencies
      );
      const used = new Set<string>();
      for (const d of dirs)
        for (const f of collect(join(ROOT, d)))
          for (const m of readFileSync(f, "utf8").matchAll(/from\s+["'](@ts5250\/[a-z-]+)["']/g))
            used.add(m[1]!);
      expect([...used].filter((u) => !deps.includes(u)), `${pkgPath} の未宣言依存`).toEqual([]);
    }
  });
});
