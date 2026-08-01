import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * **`@as400web/hostserver` から `@as400web/core` へ依存しないこと。**
 *
 * このパッケージは「IBM i に SQL を投げたい／IFS を読み書きしたいが、5250 の画面
 * エミュレーションは要らない」利用者のために core から切り出したもので、逆向きの辺を
 * 1 本でも引いた時点で切り出しの意味が消える。しかも**引いても型検査もビルドも通る**
 * （monorepo では両方が同じ node_modules から解決できてしまう）ので、ここで塞ぐ。
 *
 * **列挙ではなく走査にする。** 「このファイルとこのファイルを検査する」と書くと、
 * 後から足されたファイルが素通りする。同じ理由で `20260729-connect-failed-semantics` は
 * `CONNECT_FAILED` の不在検査を走査で書いている。
 *
 * `dependencies` も併せて固定する——import が無くても `package.json` に載っていれば、
 * 次に書く人は「使ってよい」と読む。
 */

const here = dirname(fileURLToPath(import.meta.url));
const srcDir = join(here, "..", "src");

/** `src` 配下の .ts を全部集める（再帰） */
function collectSources(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...collectSources(full));
    else if (entry.name.endsWith(".ts")) out.push(full);
  }
  return out;
}

/** import / export / 動的 import の**すべて**からモジュール指定子を拾う */
function moduleSpecifiers(source: string): string[] {
  // `from "x"` と `import("x")` の両方。片方だけだと動的 import が漏れる
  // （実際 `ddm-encode.test.ts` は `await import(...)` で書かれている）
  const out: string[] = [];
  for (const m of source.matchAll(/from\s+["']([^"']+)["']/g)) out.push(m[1]!);
  for (const m of source.matchAll(/\bimport\s*\(\s*["']([^"']+)["']\s*\)/g)) out.push(m[1]!);
  return out;
}

const files = collectSources(srcDir);

describe("@as400web/core への逆依存が無い", () => {
  it("走査対象を実際に拾えている（空振りで緑にならないこと）", () => {
    // ファイルが 0 件でも forEach は通ってしまう。走査そのものを先に固定する
    expect(files.length).toBeGreaterThan(40);
  });

  it("src のどのファイルも @as400web/core を import しない", () => {
    const offenders = files.filter((f) =>
      moduleSpecifiers(readFileSync(f, "utf8")).some((s) => s.startsWith("@as400web/core"))
    );
    expect(offenders.map((f) => relative(srcDir, f))).toEqual([]);
  });

  it("TN5250 本体（protocol / screen / session / telnet / trace）を参照しない", () => {
    // 相対パスで core の木へ戻る書き方も塞ぐ（`../../core/src/...` のような細工）
    const tn5250 = /(^|\/)(protocol|screen|session|telnet|trace)\//;
    const offenders: string[] = [];
    for (const f of files) {
      for (const spec of moduleSpecifiers(readFileSync(f, "utf8"))) {
        if (spec.includes("..") && tn5250.test(spec)) offenders.push(`${relative(srcDir, f)} → ${spec}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("package.json の dependencies は base / ebcdic / scs の 3 つだけ", () => {
    const pkg = JSON.parse(readFileSync(join(here, "..", "package.json"), "utf8")) as {
      dependencies: Record<string, string>;
    };
    expect(Object.keys(pkg.dependencies).sort()).toEqual([
      "@as400web/base",
      "@as400web/ebcdic",
      "@as400web/scs"
    ]);
  });

  it("ログは @as400web/base から取る（自前の log モジュールを持たない）", () => {
    // 複製すると `setLogSink` が効かなくなる（`core/test/log-sink-single-instance.test.ts`）。
    // 「hostserver 内に log の実体を作らない」を構造として固定しておく
    const localLogModules = files.filter((f) => /(^|\/)log(-[a-z]+)?\.ts$/.test(relative(srcDir, f)));
    expect(localLogModules.map((f) => relative(srcDir, f))).toEqual([]);
    for (const f of files) {
      const src = readFileSync(f, "utf8");
      if (!src.includes("childLog")) continue;
      expect(moduleSpecifiers(src), `${relative(srcDir, f)} の childLog の取得元`).toContain(
        "@as400web/base"
      );
    }
  });
});
