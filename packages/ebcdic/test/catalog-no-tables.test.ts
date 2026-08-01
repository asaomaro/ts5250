import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * `@as400web/ebcdic/catalog` から**変換表へ到達しない**ことの検査。
 *
 * この性質は「ブラウザのバンドルに 1.17 MB の表を入れない」ためだけに在り、
 * **壊れても型検査もテストもビルドも通ってしまう**——`catalog.ts` に
 * `import { codecForCcsid } from "./codec.js"` を 1 行足すだけで、`catalog` を
 * 使う側（`@as400web/tn5250/browser` 経由の web-ui）のバンドルが一気に膨らむ。
 * サイズを見ていなければ誰も気づかない。だから到達可能性そのものを固定する。
 *
 * 検査は **src の import グラフを実際にたどる**（ビルド成果物に依存しないので
 * `npm run build` の前でも走る）。表そのものは `tables/` 配下にしか無いので、
 * グラフに `tables/` が現れないことと、到達したファイルの合計サイズが小さいことを見る。
 */
const here = dirname(fileURLToPath(import.meta.url));
const srcDir = join(here, "..", "src");

/**
 * 相対 import（`./x.js` / `../y/z.js`）だけを拾う。パッケージ参照は対象外。
 *
 * 3 つの形を拾う。**どれか 1 つでも落とすとガードが黙って素通しする**:
 *   1. `import { x } from "./y.js"` / `export { x } from "./y.js"` … `from "…"`
 *   2. `import "./y.js"`                                           … 束縛なしの副作用 import
 *   3. `await import("./y.js")`                                    … 動的 import
 *
 * `import type ... from` も拾ってしまうが（実行時には消えるので過剰計上）、
 * それは「表を見逃さない」安全側なので許容する。
 */
const RELATIVE_IMPORT = /(?:from\s*|\bimport\s*\(\s*|\bimport\s+)"(\.[^"]*)"/g;

/** entry から相対 import をたどって到達可能な src ファイルを集める */
function reachableFrom(entry: string): Map<string, number> {
  const seen = new Map<string, number>();
  const queue = [resolve(srcDir, entry)];
  while (queue.length > 0) {
    const file = queue.pop()!;
    if (seen.has(file)) continue;
    const source = readFileSync(file, "utf8");
    seen.set(file, source.length);
    for (const m of source.matchAll(RELATIVE_IMPORT)) {
      // 出力は .js を指すが、たどるのは src の .ts
      queue.push(resolve(dirname(file), m[1]!.replace(/\.js$/, ".ts")));
    }
  }
  return seen;
}

describe("@as400web/ebcdic/catalog は変換表を引き込まない", () => {
  const fromCatalog = reachableFrom("catalog.ts");
  const rel = (f: string): string => f.slice(srcDir.length + 1);

  it("到達可能なファイルに tables/ が 1 つも含まれない", () => {
    const files = [...fromCatalog.keys()].map(rel).sort();
    expect(files.filter((f) => f.startsWith("tables/"))).toEqual([]);
    // 実際に到達するのは入口と一覧の 2 ファイルだけ
    expect(files).toEqual(["catalog.ts", "ccsid-catalog.ts"]);
  });

  it("到達可能なソースの合計が 8 KB 未満（表が混ざれば桁違いに超える）", () => {
    const total = [...fromCatalog.values()].reduce((a, b) => a + b, 0);
    expect(total).toBeLessThan(8 * 1024);
  });

  it("対照: root（index.ts）からは表に到達する＝検査が実際に効いている", () => {
    // 混在 CCSID は SBCS 部 / DBCS 部 / 合成の 3 モジュールに割ってある
    // （`20260726-ccsid-table-bundling`）。バレルからは全部に到達するのが正しい。
    const files = [...reachableFrom("index.ts").keys()].map(rel);
    expect(files.filter((f) => f.startsWith("tables/")).sort()).toEqual([
      "tables/ibm1399-dbcs.ts",
      "tables/ibm1399-sbcs.ts",
      "tables/ibm1399.ts",
      "tables/ibm273.ts",
      "tables/ibm37.ts",
      "tables/ibm930-dbcs.ts",
      "tables/ibm930-sbcs.ts",
      "tables/ibm930.ts",
      "tables/ibm939-dbcs.ts",
      "tables/ibm939-sbcs.ts",
      "tables/ibm939.ts"
    ]);
  });
});
