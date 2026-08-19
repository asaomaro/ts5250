import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * **`@ts5250/tn3270/browser` は Node API を引き込まない。**
 *
 * root（`index.ts`）は `transport/tcp.ts` 経由で `node:net` / `node:tls` を含むので、
 * ブラウザから import してはならない。**入口を分けただけでは守れない**——
 * `browser.ts` が辿り着く先に 1 本でも `node:*` があれば、bundler はそれを引き込む。
 * だから**到達可能な範囲を実際に辿って**検査する。
 *
 * 同じ轍は 5250 側で踏んでいる（AGENTS.md「ブラウザから触る側は狭い入口を使う」）。
 */

const here = dirname(fileURLToPath(import.meta.url));
const SRC = join(here, "..", "src");

/** `browser.ts` から相対 import で到達できる src 内のファイルを全部集める */
function reachableFrom(entry: string): string[] {
  const seen = new Set<string>();
  const stack = [entry];
  while (stack.length > 0) {
    const file = stack.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);
    const src = readFileSync(file, "utf8");
    for (const m of src.matchAll(/from\s+["'](\.[^"']+)["']/g)) {
      // ESM の ".js" は TS 上は ".ts"
      const rel = m[1]!.replace(/\.js$/, ".ts");
      const target = resolve(dirname(file), rel);
      if (existsSync(target)) stack.push(target);
    }
  }
  return [...seen];
}

describe("ブラウザ入口の純度", () => {
  it("browser.ts から到達できる範囲に node:* の import が無い", () => {
    const files = reachableFrom(join(SRC, "browser.ts"));
    // 空振りで緑にならないこと（少なくとも入口＋数ファイルは辿れるはず）
    expect(files.length).toBeGreaterThan(2);

    const offenders: string[] = [];
    for (const f of files) {
      const src = readFileSync(f, "utf8");
      if (/from\s+["']node:/.test(src)) offenders.push(f.slice(SRC.length + 1));
    }
    expect(offenders).toEqual([]);
  });

  it("root の index.ts は（対照として）node:* を含む経路を持つ", () => {
    // 上のテストが「そもそも node:* を見つけられない」ために緑になっていないことの裏取り
    const files = reachableFrom(join(SRC, "index.ts"));
    const withNode = files.filter((f) => /from\s+["']node:/.test(readFileSync(f, "utf8")));
    expect(withNode.length).toBeGreaterThan(0);
  });
});
