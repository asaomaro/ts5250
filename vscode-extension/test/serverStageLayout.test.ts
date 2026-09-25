import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// vitestの実行はViteの変換系を通るためESM扱い——`__dirname`ではなく`import.meta.url`を使う
const testDir = dirname(fileURLToPath(import.meta.url));
const extDir = join(testDir, "..");

/**
 * `scripts/prepare-server.mjs`（`server-stage/`を組み立てる側）と
 * `src/extension.ts`の`resolveServerPaths`（Production分岐で`server-stage/`を読む側）は、
 * 同じ相対レイアウトを2か所で決め打ちしている（`electron/main.cjs`も同じ決め打ちを
 * 独立に持つ——本PJの配布物レイアウトの既定の作法）。
 *
 * ESMスクリプト（prepare-server.mjs）とコンパイル済みCommonJS（extension.ts）を
 * またぐため、モジュールとして1か所に共有するのは`.vscodeignore`の除外境界を
 * 越える複雑さを招く（`scripts/`は配布物から除外している）。代わりに、対応関係が
 * 崩れたら落ちるテストで固定する（`.aidev/conventions/paired-artifact-sync.md`
 * 「3. 共有できないときは、対応関係を機械で固定するテストを置く」。`protocol-sync.test.ts`
 * と同じ手法）。
 */
describe("server-stage レイアウトの対応（prepare-server.mjs と resolveServerPaths）", () => {
  it("web-uiの置き場所（packages/web-ui/dist）が両側で一致する", () => {
    const prepareSrc = readFileSync(join(extDir, "scripts", "prepare-server.mjs"), "utf8");
    const extensionSrc = readFileSync(join(extDir, "src", "extension.ts"), "utf8");

    expect(prepareSrc).toContain('join(STAGE, "packages", "web-ui", "dist")');
    expect(extensionSrc).toContain('join(stage, "packages", "web-ui", "dist")');
  });

  it("自前パッケージの置き場所（node_modules/@ts5250/<name>/dist）とサーバー本体の経路が一致する", () => {
    const prepareSrc = readFileSync(join(extDir, "scripts", "prepare-server.mjs"), "utf8");
    const extensionSrc = readFileSync(join(extDir, "src", "extension.ts"), "utf8");

    // prepare-server.mjs: 自前パッケージ（"server"を含む）を node_modules/@ts5250/<name>/dist へ実体コピーする
    expect(prepareSrc).toContain('join(STAGE, "node_modules", "@ts5250", name)');
    // extension.ts: entry パッケージ名は "server"（prepare-server.mjs の collectLibPackages("server") と同じ）
    expect(extensionSrc).toContain('join(stage, "node_modules", "@ts5250", "server", "dist", "main.js")');
  });
});
