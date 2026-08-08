import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * **ブラウザから触る側は狭い入口を使う**（AGENTS.md「パッケージ分割と入口」）。
 *
 * `@ts5250/tn5250` の root は `transport/tcp.ts` 経由で `node:net` / `node:tls` を
 * 巻き込むので、**値として import するとブラウザで落ちる**。
 * 実際 `ScreenGrid.vue` が `fieldId` を root から取っていて、
 * `npm run dev`（vite dev）でアプリが起動しなくなっていた
 * （`Module "node:net" has been externalized … Cannot access "node:net.connect"`）。
 * 本番ビルドでは警告止まりで気づけないので、**走査で止める**。
 *
 * `import type` は実行時コードを出さないので root から取ってよい。
 */
/**
 * **パッケージ dir から実行する前提**（AGENTS.md「web-ui のテストはパッケージ dir から実行する」）。
 * `import.meta.url` は vitest の変換後だと相対のままで解決できないので cwd から辿る。
 */
const SRC = join(process.cwd(), "src");

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return walk(path);
    return /\.(ts|vue)$/u.test(name) ? [path] : [];
  });
}

/** `import type` ではない `@ts5250/tn5250`（root）からの import */
const ROOT_VALUE_IMPORT = /^\s*import\s+(?!type\b)[^;]*?from\s+["']@ts5250\/tn5250["']/gmu;

describe("ブラウザの入口", () => {
  it("**root の `@ts5250/tn5250` を値として import しない**（`node:net` を巻き込む）", () => {
    const offenders = walk(SRC)
      .map((path) => ({ path, hits: readFileSync(path, "utf8").match(ROOT_VALUE_IMPORT) ?? [] }))
      .filter((x) => x.hits.length > 0)
      .map((x) => `${x.path.slice(SRC.length + 1)}: ${x.hits.join(" / ")}`);
    expect(offenders, "値が要るなら `@ts5250/tn5250/browser` から取る").toEqual([]);
  });

  it("`import type` は root からでよい（実行時コードを出さない）", () => {
    const typeOnly = walk(SRC).filter((path) =>
      /import\s+type\s[^;]*?from\s+["']@ts5250\/tn5250["']/u.test(readFileSync(path, "utf8"))
    );
    // 実際に使われている前提を固定する（この形が消えたらテストの意味も無くなる）
    expect(typeOnly.length).toBeGreaterThan(0);
  });
});
