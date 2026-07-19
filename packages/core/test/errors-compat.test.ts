import { describe, it, expect } from "vitest";
import { As400Error, Tn5250Error } from "../src/index.js";
import { SqlError } from "../src/hostserver/db/query.js";

/**
 * 例外の改名（`Tn5250Error` → `As400Error`）の後方互換。
 *
 * 旧名は**外部利用者のコードを壊さないためだけ**に残している互換シムで、
 * リポジトリ内の新しいコードは新名を使う。
 *
 * このテストは実際に必要だった——改名時に `index.ts` の re-export まで一括置換してしまい、
 * **旧名が外に出なくなって server 全体が型エラーになった**。人手の注意ではなく型で守る。
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
});
