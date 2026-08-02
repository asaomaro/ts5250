import { describe, it, expect } from "vitest";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import * as core from "../src/index.js";
import * as hostserver from "@ts5250/hostserver";

/**
 * **`@ts5250/tn5250` はホストサーバーを実行時に引かない。**
 *
 * 経緯: `20260801-library-extraction-hostserver`（PR #233）でホストサーバー層を
 * `@ts5250/hostserver` へ切り出したとき、利用側を壊さないために core の `index.ts` に
 * 再輸出を残した。その結果 **`core → hostserver` の実行時依存が残り**、
 * 「TN5250 だけ欲しい」利用者はホストサーバー一式を引き取り続けていた。
 * `20260801-library-extraction-drop-core-reexport` で利用側を直参照へ移し、再輸出を撤去した。
 *
 * **このファイルは前身（`hostserver-reexport.test.ts`）の裏返しである。**
 * あちらは「再輸出が到達可能なこと」を検査していた。同じ名前のまま中身だけ反転させると、
 * 次に読む人が中身と逆の期待をするので、ファイル名ごと変えてある。
 *
 * **例外は無い（`20260801-library-extraction-cleanup` で無くした）。**
 * 一時は `browser.ts` が hostserver の型を `export type` で中継しており、その 1 点のために
 * `packages/tn5250` が `node:net` を含むパッケージを `dependencies` に持っていた。
 * いまは **web-ui が hostserver を `devDependencies` に持って直接 `import type` する**ので、
 * core は宣言ごと手を切っている。
 *
 * **宣言（`package.json` / `tsconfig.json`）も検査する。** ソースに参照が無くても
 * 宣言が残っていれば「実行時に引かないだけで依存はしている」状態に戻れてしまう。
 */

const here = dirname(fileURLToPath(import.meta.url));
const srcDir = join(here, "..", "src");
const distDir = join(here, "..", "dist");

function collect(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const f = join(dir, e.name);
    if (e.isDirectory()) out.push(...collect(f));
    else if (e.name.endsWith(".ts")) out.push(f);
  }
  return out;
}

/**
 * ビルド成果物を**コメントを剥がして**読む。無ければ **落とす**
 * （skip にすると「ビルドしていないから緑」という無意味な緑になる）。
 *
 * **剥がすのは必須**——`tsc` は JSDoc を出力にそのまま残すので、
 * 「hostserver をここへ戻すな」と書いた注意書き自体が検査に引っかかる（実際に踏んだ）。
 * 見たいのは**実行時に解決されるモジュール指定子**であってコメントの文字列ではない。
 */
function readDist(name: string): string {
  const p = join(distDir, name);
  if (!existsSync(p)) {
    throw new Error(
      `${name} が無い。この検査はビルド成果物を読むので、先に \`npm run build\` を通すこと` +
        "（skip にすると「ビルドしていないから緑」という無意味な緑になる）"
    );
  }
  return readFileSync(p, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "");
}

describe("core はホストサーバーを再輸出しない", () => {
  it("hostserver の実行時 export が core のバレルから 1 つも取れない", () => {
    // 撤去した列挙を戻すと、ここに名前が現れる
    const leaked = Object.keys(hostserver).filter((n) => n in core);
    expect(leaked).toEqual([]);
  });

  it("検査が空振りしていない（hostserver 側に実行時 export が実在する）", () => {
    // 上のテストは `hostserver` が空でも通ってしまう。基準の方を先に固定する
    expect(Object.keys(hostserver).length).toBeGreaterThan(30);
    expect(hostserver.DbConnection).toBeTypeOf("function");
  });

  it("src のどこからも hostserver を参照しない（例外なし）", () => {
    const offenders: string[] = [];
    for (const f of collect(srcDir)) {
      const src = readFileSync(f, "utf8");
      for (const m of src.matchAll(/^.*@ts5250\/hostserver.*$/gm)) {
        const line = m[0];
        if (/^\s*(\/\/|\*|\/\*)/.test(line)) continue; // コメントは対象外
        offenders.push(`${relative(srcDir, f)}: ${line.trim()}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("package.json / tsconfig.json のどちらにも hostserver の宣言が無い", () => {
    // **ソースに参照が無いだけでは足りない。** 宣言が残っていれば
    // 「実行時に引かないだけで依存はしている」状態に戻れてしまう
    const pkg = JSON.parse(readFileSync(join(here, "..", "package.json"), "utf8")) as {
      dependencies: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    expect(Object.keys(pkg.dependencies)).not.toContain("@ts5250/hostserver");
    expect(Object.keys(pkg.devDependencies ?? {})).not.toContain("@ts5250/hostserver");

    const tsconfig = readFileSync(join(here, "..", "tsconfig.json"), "utf8");
    expect(tsconfig).not.toContain("hostserver");
  });

  it("web-ui は hostserver を devDependencies にだけ持つ（型のみ利用）", () => {
    // 型だけ使うので実行時依存ではない。`dependencies` に入れると本番インストールに
    // Node 専用パッケージが混じる（`20260801-library-extraction-cleanup` D1）
    const wu = JSON.parse(
      readFileSync(join(here, "..", "..", "web-ui", "package.json"), "utf8")
    ) as { dependencies: Record<string, string>; devDependencies: Record<string, string> };
    expect(Object.keys(wu.devDependencies)).toContain("@ts5250/hostserver");
    expect(Object.keys(wu.dependencies)).not.toContain("@ts5250/hostserver");
  });

  it("dist/index.js に hostserver への実行時 import が無い", () => {
    // **ソースの `export type` は目視で値と区別しにくい。** 実行時に何が残るかは
    // 成果物を見るのが唯一確実（撤去前は 33 箇所あった）
    expect(readDist("index.js")).not.toContain("@ts5250/hostserver");
  });

  it("dist/browser.js にも hostserver への実行時 import が無い", () => {
    // `export type` が値に化けるとここに現れる（web-ui のバンドルに node:net が入る）
    expect(readDist("browser.js")).not.toContain("@ts5250/hostserver");
  });
});
