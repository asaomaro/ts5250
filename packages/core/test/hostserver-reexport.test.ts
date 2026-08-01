import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as core from "../src/index.js";
import * as browser from "../src/browser.js";
import * as hostserver from "@as400web/hostserver";

/**
 * ホストサーバー層を `@as400web/hostserver` へ切り出した後の**後方互換**。
 *
 * core は実体を持たず再輸出するだけになったので、**列挙を 1 つ落としても core 内部は
 * 何も壊れず、型検査もビルドも通る**——壊れるのは外の利用者だけ、という気づけない種類の
 * 回帰になる。`Tn5250Error` → `As400Error` の改名時に実際に起きた（`errors-compat.test.ts`）。
 * codec を切り出したときと同じ構図なので、同じやり方（`codec-reexport.test.ts`）で押さえる。
 *
 * **名前を列挙しない。** `index.ts` から `@as400web/hostserver` 由来の export 名を**読み取って**
 * 到達可能性を確かめる。手で書き写すと、追加された export が検査から漏れる
 * ——そして漏れた export こそが落としても気づかれないものになる。
 *
 * 外の利用者は `packages/server` の 37 ファイルと `packages/web-ui` の 22 ファイル、
 * `tools/hostserver-check`。いずれも `@as400web/core` / `@as400web/core/browser` 経由で、
 * 本作業ではこれらを 1 行も変えていない。
 */

const here = dirname(fileURLToPath(import.meta.url));

/** `export { a, b as c, type D } from "@as400web/hostserver";` から実行時に見える名前を拾う */
function reexportedRuntimeNames(source: string): string[] {
  const names: string[] = [];
  const block = /export\s+(type\s+)?\{([^}]*)\}\s*from\s+["']@as400web\/hostserver["']/g;
  for (const m of source.matchAll(block)) {
    // `export type { … }` は丸ごと型なので実行時には現れない
    if (m[1]) continue;
    for (const raw of m[2]!.split(",")) {
      const item = raw.replace(/\/\/.*$/gm, "").trim();
      if (!item || item.startsWith("type ")) continue; // インラインの `type X` も型だけ
      // `X as Y` は外に出るのは Y
      const alias = /\bas\s+([A-Za-z_$][\w$]*)\s*$/.exec(item);
      names.push(alias ? alias[1]! : item);
    }
  }
  return names;
}

const indexSource = readFileSync(join(here, "..", "src", "index.ts"), "utf8");
const runtimeNames = reexportedRuntimeNames(indexSource);

describe("ホストサーバーの再輸出（@as400web/core 経由の後方互換）", () => {
  it("検査対象を実際に拾えている（空振りで緑にならないこと）", () => {
    // 正規表現が空振りしても `for…of` は通ってしまうので、件数そのものを先に固定する
    expect(runtimeNames.length).toBeGreaterThan(30);
    // 代表例が拾えているか（抽出のバグで別のものを数えていないことの確認）
    expect(runtimeNames).toContain("DbConnection");
    expect(runtimeNames).toContain("dtaqDecodeEbcdic"); // 別名で出しているもの
  });

  it("index.ts が @as400web/hostserver から出す名前は、すべて実行時に到達できる", () => {
    const missing = runtimeNames.filter((n) => !(n in core));
    expect(missing).toEqual([]);
  });

  it("@as400web/hostserver の公開面が漏れなく core からも取れる", () => {
    // **上のテストだけでは列挙の削除を検出できない**——`index.ts` そのものを検査対象の
    // 出どころにしているので、行ごと消せば検査対象からも消える。外部の基準
    // （hostserver 自身の公開面）と突き合わせて初めて「落とした」が分かる。
    //
    // 分割前、この 1 群は core の `index.ts` が直接出していた。hostserver 側の `index.ts` は
    // それを写して作ったので、**両者は 1 対 1 で対応していなければならない**。
    const missing = Object.keys(hostserver).filter((n) => !(n in core));
    expect(missing).toEqual([]);
  });

  it("主要な入口が実際に使える形で取れている", () => {
    expect(core.DbConnection).toBeTypeOf("function");
    expect(core.IfsConnection).toBeTypeOf("function");
    expect(core.DtaqConnection).toBeTypeOf("function");
    expect(core.DdmConnection).toBeTypeOf("function");
    expect(core.CommandConnection).toBeTypeOf("function");
    expect(core.NetPrintConnection).toBeTypeOf("function");
    expect(core.signon).toBeTypeOf("function");
    // 純関数は呼んで確かめる（存在するだけでなく中身が生きていること）
    expect(core.isNonQueryStatement("insert into t values(1)")).toBe(true);
    expect(core.isNonQueryStatement("select * from t")).toBe(false);
    expect(core.typeName(core.DB2.CHAR)).toBeTypeOf("string");
    expect(core.statusName(core.PORT_MAPPER_PORT)).toBeTypeOf("string");
  });

  it("/browser サブパスの hostserver 由来は**型だけ**（node:net をブラウザへ持ち込まない）", () => {
    const browserSource = readFileSync(join(here, "..", "src", "browser.ts"), "utf8");
    const blocks = [...browserSource.matchAll(/export\s+(type\s+)?\{[^}]*\}\s*from\s+["']@as400web\/hostserver["']/g)];
    expect(blocks.length).toBeGreaterThan(0);
    for (const b of blocks) {
      // `export type { … }` でなければ実体が入り、`node:net` / `node:tls` が
      // ブラウザのバンドルへ引き込まれる（externalize されて実行時に落ちる）
      expect(b[1], `browser.ts の再輸出が値になっている: ${b[0]!.slice(0, 60)}…`).toBeDefined();
    }
    // 実行時の名前空間に hostserver 由来の**値**が現れないことも確かめる
    expect(Object.keys(browser)).not.toContain("IfsConnection");
    expect(Object.keys(browser)).not.toContain("DbConnection");
  });

  it("package.json が @as400web/hostserver に依存している", () => {
    const pkg = JSON.parse(readFileSync(join(here, "..", "package.json"), "utf8")) as {
      dependencies: Record<string, string>;
    };
    expect(pkg.dependencies["@as400web/hostserver"]).toBeDefined();
    expect(pkg.dependencies["@as400web/base"]).toBeDefined();
  });
});
