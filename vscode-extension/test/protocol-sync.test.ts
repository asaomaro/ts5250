import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// vitestの実行はViteの変換系を通るためESM扱い——`__dirname`ではなく`import.meta.url`を使う
const testDir = dirname(fileURLToPath(import.meta.url));

/**
 * `protocol.ts`（このパッケージ）と`packages/web-ui/src/embed-protocol.ts`の型定義が
 * 一字一句一致することを固定する（design.md「設計判断」——手で同期を保つ複製の
 * 唯一の担保）。先頭のファイル冒頭コメント（パッケージごとに文言が違ってよい部分）だけを
 * 除き、それ以降を比較する。
 */
function stripLeadingDocComment(src: string): string {
  const m = /^\/\*\*[\s\S]*?\*\/\n+/.exec(src);
  return m ? src.slice(m[0].length) : src;
}

describe("protocol.ts と embed-protocol.ts の同期", () => {
  it("先頭コメントを除いた型定義部分が一致する", () => {
    const mine = stripLeadingDocComment(readFileSync(join(testDir, "..", "src", "protocol.ts"), "utf8"));
    const theirs = stripLeadingDocComment(
      readFileSync(join(testDir, "..", "..", "packages", "web-ui", "src", "embed-protocol.ts"), "utf8")
    );
    expect(mine).toBe(theirs);
  });
});
