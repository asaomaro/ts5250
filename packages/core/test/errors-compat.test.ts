import { describe, it, expect } from "vitest";
import { As400Error, Tn5250Error } from "../src/index.js";
import { As400Error as BaseAs400Error } from "@as400web/base";
import { SqlError } from "@as400web/hostserver";

/**
 * 例外の改名（`Tn5250Error` → `As400Error`）の後方互換。
 *
 * 旧名は**外部利用者のコードを壊さないためだけ**に残している互換シムで、
 * リポジトリ内の新しいコードは新名を使う。
 *
 * このテストは実際に必要だった——改名時に `index.ts` の re-export まで一括置換してしまい、
 * **旧名が外に出なくなって server 全体が型エラーになった**。人手の注意ではなく型で守る。
 *
 * **パッケージ分割後は、もう 1 つの役目を兼ねる**（`20260801-library-extraction-hostserver`）。
 * `As400Error` の定義は `@as400web/base` に 1 つだけ在り、`@as400web/core` はそれを再輸出し、
 * `@as400web/hostserver` の `SqlError` はそれを継承している——という**3 パッケージに跨る同一性**を
 * ここで検査する。クラスが複製されると `instanceof` は静かに false になり、
 * `catch (e) { if (e instanceof As400Error) … }` と書いた利用側が黙って壊れる。
 * 型検査では捕まらない（構造的に同じ形なので）ので、実行時に固定するしかない。
 */
describe("As400Error / Tn5250Error", () => {
  it("旧名と新名は同一のクラス", () => {
    expect(Tn5250Error).toBe(As400Error);
  });

  it("旧名で作ったものが新名の instanceof を通る", () => {
    const e = new Tn5250Error("CONFIG_ERROR", "x");
    expect(e).toBeInstanceOf(As400Error);
    expect(e).toBeInstanceOf(Error);
  });

  it("新名で作ったものが旧名の instanceof を通る（既存の catch が壊れない）", () => {
    const e = new As400Error("CONFIG_ERROR", "x");
    expect(e).toBeInstanceOf(Tn5250Error);
  });

  it("name は新名になっている", () => {
    expect(new As400Error("CONFIG_ERROR", "x").name).toBe("As400Error");
  });

  it("code と message と cause を保持する", () => {
    const cause = new Error("原因");
    const e = new As400Error("PROTOCOL_ERROR", "こわれた", { cause });
    expect(e.code).toBe("PROTOCOL_ERROR");
    expect(e.message).toBe("こわれた");
    expect(e.cause).toBe(cause);
  });

  it("サブクラスも両方の instanceof を通る", () => {
    const e = new SqlError(-204, "42704", "no table");
    expect(e).toBeInstanceOf(As400Error);
    expect(e).toBeInstanceOf(Tn5250Error);
    expect(e.code).toBe("SQL_ERROR");
  });

  it("`@as400web/core` が出す As400Error は `@as400web/base` の実体そのもの", () => {
    // core が再輸出ではなく自前の複製を持ってしまうと、ここが別クラスになる
    expect(As400Error).toBe(BaseAs400Error);
  });

  it("`@as400web/hostserver` の例外が `@as400web/base` の instanceof を通る", () => {
    // パッケージ境界を跨いだ instanceof。クラスが複製されると静かに false になる箇所
    const e = new SqlError(-204, "42704", "no table");
    expect(e).toBeInstanceOf(BaseAs400Error);
  });
});
