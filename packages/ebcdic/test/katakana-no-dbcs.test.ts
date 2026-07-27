import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * `@as400web/ebcdic/katakana` から **DBCS 変換表へ到達しない**ことの検査。
 *
 * `katakanaChar` は CCSID 930 の SBCS 部 256 要素しか読まないが、
 * 元は `codec.ts` に同居しており、そのせいで web-ui の本番バンドルに
 * ibm930 / ibm939 の表が丸ごと（DBCS 部込みで約 600 KB）入っていた。
 *
 * この分離は**壊れても型検査もテストもビルドも通る**。
 * `katakana.ts` に `import { codecForCcsid } from "./codec.js"` を 1 行足すだけで
 * 元の状態へ戻り、サイズを見ていなければ誰も気づかない。だから到達可能性そのものを固定する。
 *
 * 検査は src の import グラフを実際にたどる（ビルド成果物に依存しないので
 * `npm run build` の前でも走る）。手法は `catalog-no-tables.test.ts` と同じ。
 */
const here = dirname(fileURLToPath(import.meta.url));
const srcDir = join(here, "..", "src");

/**
 * 相対 import（`./x.js` / `../y/z.js`）だけを拾う。パッケージ参照は対象外。
 * `from "…"` / 束縛なしの副作用 import / 動的 import の 3 形を拾う
 * （どれか 1 つでも落とすとガードが黙って素通しする）。
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
      queue.push(resolve(dirname(file), m[1]!.replace(/\.js$/, ".ts")));
    }
  }
  return seen;
}

describe("@as400web/ebcdic/katakana は DBCS 表を引き込まない", () => {
  const reached = reachableFrom("katakana.ts");
  const rel = (f: string): string => f.slice(srcDir.length + 1);
  const files = [...reached.keys()].map(rel).sort();

  it("到達するのは入口・型・930 の SBCS 部の 3 ファイルだけ", () => {
    expect(files).toEqual(["katakana.ts", "table-types.ts", "tables/ibm930-sbcs.ts"]);
  });

  it("DBCS 部にも合成モジュールにも到達しない", () => {
    // 合成モジュール（tables/ibm930.ts 等）を経由すると DBCS 部が芋づるで付いてくる
    expect(files.filter((f) => f.endsWith("-dbcs.ts"))).toEqual([]);
    expect(files.filter((f) => /tables\/ibm\d+\.ts$/.test(f))).toEqual([]);
  });

  it("codec.ts に到達しない（5 表すべてを静的 import するモジュール）", () => {
    expect(files).not.toContain("codec.ts");
    expect(files).not.toContain("pure-dbcs.ts");
    expect(files).not.toContain("ccsid-text.ts");
  });

  it("到達可能なソースの合計が 16 KB 未満（DBCS 部が混ざれば桁違いに超える）", () => {
    const total = [...reached.values()].reduce((a, b) => a + b, 0);
    expect(total).toBeLessThan(16 * 1024);
  });

  it("対照: codec.ts からは DBCS 部に到達する＝検査が実際に効いている", () => {
    const fromCodec = [...reachableFrom("codec.ts").keys()].map(rel);
    expect(fromCodec.filter((f) => f.endsWith("-dbcs.ts")).sort()).toEqual([
      "tables/ibm1399-dbcs.ts",
      "tables/ibm930-dbcs.ts",
      "tables/ibm939-dbcs.ts"
    ]);
  });
});
