import { describe, it, expect } from "vitest";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import * as core from "../src/index.js";
import * as hostserver from "@as400web/hostserver";

/**
 * **`@as400web/core` はホストサーバーを実行時に引かない。**
 *
 * 経緯: `20260801-library-extraction-hostserver`（PR #233）でホストサーバー層を
 * `@as400web/hostserver` へ切り出したとき、利用側を壊さないために core の `index.ts` に
 * 再輸出を残した。その結果 **`core → hostserver` の実行時依存が残り**、
 * 「TN5250 だけ欲しい」利用者はホストサーバー一式を引き取り続けていた。
 * `20260801-library-extraction-drop-core-reexport` で利用側を直参照へ移し、再輸出を撤去した。
 *
 * **このファイルは前身（`hostserver-reexport.test.ts`）の裏返しである。**
 * あちらは「再輸出が到達可能なこと」を検査していた。同じ名前のまま中身だけ反転させると、
 * 次に読む人が中身と逆の期待をするので、ファイル名ごと変えてある。
 *
 * **`browser.ts` の型のみ再輸出 3 箇所は例外**（`UploadRejection` / `IfsEntry` /
 * `IfsListResult` / dtaq 型群）。web-ui がこれを使うが、直参照にすると
 * **ブラウザ向けパッケージが `node:net` を含むパッケージを依存に持つ**ことになる。
 * `export type` は実行時に消えるので、`core → hostserver` は**型のみ**の辺として残る
 * （`packages/core/package.json` の `dependencies` に `@as400web/hostserver` が残るのは
 * `dist/browser.d.ts` を型検査する利用者のため。実行時には読み込まれない）。
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

/** ビルド成果物を読む。無ければ **落とす**（skip にすると「ビルドしていないから緑」になる） */
function readDist(name: string): string {
  const p = join(distDir, name);
  if (!existsSync(p)) {
    throw new Error(
      `${name} が無い。この検査はビルド成果物を読むので、先に \`npm run build\` を通すこと` +
        "（skip にすると「ビルドしていないから緑」という無意味な緑になる）"
    );
  }
  return readFileSync(p, "utf8");
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

  it("src が hostserver を参照するのは browser.ts の `export type` だけ", () => {
    const offenders: string[] = [];
    for (const f of collect(srcDir)) {
      const src = readFileSync(f, "utf8");
      const rel = relative(srcDir, f);
      for (const m of src.matchAll(/^.*@as400web\/hostserver.*$/gm)) {
        const line = m[0];
        if (/^\s*(\/\/|\*|\/\*)/.test(line)) continue; // コメントは対象外
        // browser.ts の `export type { … } from "@as400web/hostserver"` だけ許す。
        // **文の頭まで遡ってから判定する**——複数行に折れていると閉じ側の
        // `} from "@as400web/hostserver";` しか引っかからず、その行だけでは
        // `export type` か `export` かを見分けられない。
        // `lastIndexOf(…, m.index)` は m.index 自身も探索対象に含むので、
        // 1 行に収まっている文ではその行自身の `export` を指す。
        if (rel === "browser.ts") {
          const stmtStart = src.lastIndexOf("export ", m.index);
          if (stmtStart >= 0 && /^export\s+type\s*\{/.test(src.slice(stmtStart))) continue;
        }
        offenders.push(`${rel}: ${line.trim()}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("dist/index.js に hostserver への実行時 import が無い", () => {
    // **ソースの `export type` は目視で値と区別しにくい。** 実行時に何が残るかは
    // 成果物を見るのが唯一確実（撤去前は 33 箇所あった）
    expect(readDist("index.js")).not.toContain("@as400web/hostserver");
  });

  it("dist/browser.js にも hostserver への実行時 import が無い", () => {
    // `export type` が値に化けるとここに現れる（web-ui のバンドルに node:net が入る）
    expect(readDist("browser.js")).not.toContain("@as400web/hostserver");
  });
});
