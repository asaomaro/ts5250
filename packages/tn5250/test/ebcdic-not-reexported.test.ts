import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import * as tn5250 from "../src/index.js";
import * as browser from "../src/browser.js";
import * as ebcdic from "@ts5250/ebcdic";

/**
 * **`@ts5250/tn5250` は EBCDIC の変換 API を再輸出しない。**
 *
 * 経緯: codec を `@ts5250/ebcdic` へ切り出した（`20260726-library-extraction-codec`）とき、
 * 利用側を壊さないために core が 24 個の名前を再輸出していた。実測すると**使われていたのは
 * 6 個だけ**で、残り 18 個は誰も使っていなかった。再輸出は
 * 「`@ts5250/tn5250` を何でも入っている袋に戻す入口」として働くので撤去した
 * （`20260801-library-extraction-drop-ebcdic-reexport`）。
 *
 * **このファイルは前身（`codec-reexport.test.ts`）の裏返しである。**
 * あちらは「再輸出が到達可能なこと」を検査していた。中身だけ反転させると次に読む人が
 * 逆の期待をするので、ファイル名ごと変えてある（`hostserver-not-reexported.test.ts` と同じ判断）。
 *
 * **`import` は禁止していない**——`screen/` `protocol/` `session/` が内部で EBCDIC を使うのは正当。
 * 禁じるのは `export … from "@ts5250/ebcdic"` だけ。
 */

const here = dirname(fileURLToPath(import.meta.url));
const srcDir = join(here, "..", "src");
const WEBUI = join(here, "..", "..", "web-ui");

function collect(dir: string, exts: readonly string[]): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const f = join(dir, e.name);
    if (e.isDirectory()) out.push(...collect(f, exts));
    else if (exts.some((x) => e.name.endsWith(x))) out.push(f);
  }
  return out;
}

describe("tn5250 は EBCDIC を再輸出しない", () => {
  it("検査が空振りしていない（ebcdic 側に export が実在する）", () => {
    expect(Object.keys(ebcdic).length).toBeGreaterThan(10);
    expect(ebcdic.codecForCcsid).toBeTypeOf("function");
  });

  it("ebcdic の export が tn5250 のバレルから 1 つも取れない", () => {
    const leaked = Object.keys(ebcdic).filter((n) => n in tn5250);
    expect(leaked).toEqual([]);
  });

  it("ebcdic の export が /browser からも取れない", () => {
    const leaked = Object.keys(ebcdic).filter((n) => n in browser);
    expect(leaked).toEqual([]);
  });

  it("src に `export … from \"@ts5250/ebcdic\"` が無い（import は可）", () => {
    const offenders: string[] = [];
    for (const f of collect(srcDir, [".ts"])) {
      const src = readFileSync(f, "utf8");
      for (const m of src.matchAll(/^export\s+(?:type\s+)?\{[^}]*\}\s*from\s+"@ts5250\/ebcdic[^"]*";/gms))
        offenders.push(`${relative(srcDir, f)}: ${m[0]!.split("\n")[0]!}…`);
    }
    expect(offenders).toEqual([]);
  });

  /**
   * **ここが本命。** 再輸出をやめた結果 web-ui が EBCDIC を直接 import するようになったが、
   * **入口をバレルにすると変換表 18,900 行が丸ごとバンドルに入る**。
   * `20260801-library-extraction-tn5250` で `@ts5250/scs` のバレルに向けて
   * バンドルが 359,853 → 1,458,480 バイト（約 4 倍）になった実例がある。
   *
   * バンドルサイズの実測は人が回すときにしか効かないので、**入口の指定そのもの**を固定する。
   */
  it("web-ui は ebcdic のバレルを import しない（狭い入口のみ）", () => {
    const ALLOWED = ["@ts5250/ebcdic/catalog", "@ts5250/ebcdic/katakana", "@ts5250/ebcdic/codec"];
    const offenders: string[] = [];
    for (const f of collect(join(WEBUI, "src"), [".ts", ".vue"]).concat(
      collect(join(WEBUI, "test"), [".ts"])
    )) {
      const src = readFileSync(f, "utf8");
      for (const m of src.matchAll(/from\s+["'](@ts5250\/ebcdic[^"']*)["']/g)) {
        const spec = m[1]!;
        if (!ALLOWED.includes(spec)) offenders.push(`${relative(WEBUI, f)}: ${spec}`);
      }
    }
    expect(offenders, "バレルに向けると変換表が丸ごとバンドルに入る").toEqual([]);
  });

  it("web-ui が @ts5250/ebcdic を dependencies に宣言している", () => {
    const pkg = JSON.parse(readFileSync(join(WEBUI, "package.json"), "utf8")) as {
      dependencies: Record<string, string>;
    };
    expect(Object.keys(pkg.dependencies)).toContain("@ts5250/ebcdic");
  });
});
