import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * **パッケージ間の依存は一方通行である。**
 *
 * 4 回の切り出し（`20260726-library-extraction-codec` → `20260801-library-extraction-tn5250`）で
 * 「逆向きの辺を作らない」を積み上げてきたが、**検査は個別だった**——
 * `no-core-dependency.test.ts` は hostserver→core だけ、`hostserver-not-reexported.test.ts` は
 * core→hostserver だけ。パッケージが 6 つになると組み合わせは 15 通りあり、
 * 個別に書き足していく形では**書き忘れた辺が素通りする**。
 *
 * **層の順序を 1 か所で宣言し、全パッケージを走査する。**
 * 新しいパッケージが増えても下の表に足すだけで、全組み合わせが自動で検査される。
 *
 * 順序の根拠:
 *   base    … 例外の語彙・ログ・純粋なテキスト処理。依存ゼロ
 *   ebcdic  … EBCDIC 変換。依存ゼロ（base にも依存しない）
 *   scs     … スプール展開。base（全角判定）と ebcdic を使う
 *   hostserver … ホストサーバー群。base / ebcdic / scs を使う
 *   tn5250  … 5250 端末プロトコル。base / ebcdic / scs（プリンターセッション）を使う
 *   tn3270  … 3270 端末プロトコル。base / ebcdic を使う（scs は不要——プリンターは対象外）
 *
 * **hostserver / tn5250 / tn3270 はいずれも同位**——互いに依存しない（どれが上でもない）。
 * 表では順に並べているが、`hostserver → tn5250` も `tn5250 → hostserver` も、
 * `tn5250 → tn3270` も `tn3270 → tn5250` も、両方向とも禁止として検査する（下の SIBLINGS）。
 *
 * **tn3270 を足したときにここへ 2 行書くだけで済む**のがこの設計の狙い——
 * パッケージが 7 つになると組み合わせは 21 通りあり、個別に辺を書く形では書き忘れが素通りする。
 */

const here = dirname(fileURLToPath(import.meta.url));
const PACKAGES = join(here, "..", "..");

/** 下ほど上位。上位は下位を import してよいが、逆はしてはならない */
const LAYERS = ["base", "ebcdic", "scs", "hostserver", "tn5250", "tn3270"] as const;

/** 互いに依存してはならない対（同位のパッケージ） */
const SIBLINGS: readonly (readonly [string, string])[] = [
  ["hostserver", "tn5250"],
  ["tn5250", "tn3270"], // 5250 と 3270 は別プロトコル。層を共有しない
  ["hostserver", "tn3270"],
  ["base", "ebcdic"] // どちらも依存ゼロを売りにしている
];

function collect(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const f = join(dir, e.name);
    if (e.isDirectory()) out.push(...collect(f));
    else if (e.name.endsWith(".ts")) out.push(f);
  }
  return out;
}

/** `from "…"` と `import("…")` の**両方**から `@ts5250/*` の指定子を拾う */
function workspaceImports(source: string): string[] {
  const out: string[] = [];
  for (const m of source.matchAll(/from\s+["'](@ts5250\/[a-z0-9-]+)[^"']*["']/g)) out.push(m[1]!);
  for (const m of source.matchAll(/\bimport\s*\(\s*["'](@ts5250\/[a-z0-9-]+)[^"']*["']\s*\)/g))
    out.push(m[1]!);
  return out;
}

/** そのパッケージの src が import しているワークスペースパッケージ名（短縮名） */
function importedBy(pkg: string): Map<string, string[]> {
  const srcDir = join(PACKAGES, pkg, "src");
  const found = new Map<string, string[]>();
  for (const f of collect(srcDir)) {
    for (const spec of workspaceImports(readFileSync(f, "utf8"))) {
      const short = spec.slice("@ts5250/".length);
      const list = found.get(short) ?? found.set(short, []).get(short)!;
      const rel = relative(srcDir, f);
      if (!list.includes(rel)) list.push(rel);
    }
  }
  return found;
}

describe("パッケージ間の依存は一方通行", () => {
  it("走査対象が実在する（空振りで緑にならないこと）", () => {
    for (const p of LAYERS) {
      expect(existsSync(join(PACKAGES, p, "src")), `${p}/src が無い`).toBe(true);
      expect(collect(join(PACKAGES, p, "src")).length, `${p} のファイル数`).toBeGreaterThan(0);
    }
    // 少なくとも 1 本は辺があるはず（正規表現が空振りしていない証拠）
    expect([...importedBy("scs").keys()]).toContain("ebcdic");
  });

  it("上位を import している下位が無い", () => {
    const offenders: string[] = [];
    for (let i = 0; i < LAYERS.length; i++) {
      const lower = LAYERS[i]!;
      for (const [dep, files] of importedBy(lower)) {
        const j = LAYERS.indexOf(dep as (typeof LAYERS)[number]);
        if (j > i) offenders.push(`${lower} → ${dep}（${files.join(", ")}）`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("同位のパッケージが互いに依存していない", () => {
    const offenders: string[] = [];
    for (const [a, b] of SIBLINGS) {
      if (importedBy(a).has(b)) offenders.push(`${a} → ${b}`);
      if (importedBy(b).has(a)) offenders.push(`${b} → ${a}`);
    }
    expect(offenders).toEqual([]);
  });

  it("`base` と `ebcdic` は外部にもワークスペースにも依存しない", () => {
    for (const p of ["base", "ebcdic"]) {
      const pkg = JSON.parse(readFileSync(join(PACKAGES, p, "package.json"), "utf8")) as {
        dependencies?: Record<string, string>;
      };
      expect(Object.keys(pkg.dependencies ?? {}), `${p} の dependencies`).toEqual([]);
    }
  });

  it("`package.json` の宣言と実際の import が一致している", () => {
    // **宣言だけ残る／宣言せず hoisting で動く**のどちらも塞ぐ
    for (const p of LAYERS) {
      const pkg = JSON.parse(readFileSync(join(PACKAGES, p, "package.json"), "utf8")) as {
        dependencies?: Record<string, string>;
      };
      const declared = Object.keys(pkg.dependencies ?? {})
        .filter((d) => d.startsWith("@ts5250/"))
        .map((d) => d.slice("@ts5250/".length))
        .sort();
      const used = [...importedBy(p).keys()].sort();
      // **両方向で一致を要求する**——「宣言だけ残る」（依存を消したのに package.json は
      // そのまま）と「宣言せず hoisting で動く」（monorepo だと動いてしまう）の
      // どちらも塞ぐ。片側だけの検査にすると、もう片方が静かに通る
      expect(declared, `${p} の宣言と実際の import`).toEqual(used);
    }
  });
});
