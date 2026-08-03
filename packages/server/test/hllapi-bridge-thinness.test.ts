import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * **接続層（Rust）にロジックを置かない**——この不変条件をソース走査で固定する。
 *
 * 要件は「Rust で薄い接続層を作り、ロジックは TypeScript」。
 * 散文の約束は破られるので機械で検査する。破られ方は決まっている——
 * 「1 つだけ機能番号を見て分岐する」を足してしまうこと。一度許すと次の人が 2 つ目を足す。
 *
 * **なぜ Rust 側のテストではなく、ここに置くのか。**
 * `cargo test` はこのリポジトリの標準の検査（`npm test`）に含まれず、
 * 環境によっては動かない（C コンパイラが無いとテスト実行ファイルをリンクできない）。
 * **走らない検査は無いのと同じ**なので、必ず走る側に置く。
 * ソースを読むだけなので Rust ツールチェーンも要らない。
 */
// **テストファイル基準で解決する**（`process.cwd()` は実行の仕方で変わる）
const SRC = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "crates", "hllapi", "src");

function sources(): { name: string; code: string }[] {
  return readdirSync(SRC)
    .filter((f) => f.endsWith(".rs"))
    // 検査そのもの（selftest）は対象外——検証のために語彙を含むのは当然
    .filter((f) => f !== "selftest.rs")
    .map((name) => {
      const raw = readFileSync(join(SRC, name), "utf8");
      // コメントと #[cfg(test)] 以降を落として「実際に効くコード」だけを見る
      const body = raw.includes("#[cfg(test)]") ? raw.slice(0, raw.indexOf("#[cfg(test)]")) : raw;
      const code = body
        .split("\n")
        .map((l) => l.trim())
        .filter((l) => !l.startsWith("//"))
        .join("\n");
      return { name, code };
    });
}

describe("接続層の薄さ", () => {
  it("ソースが読める（場所が変わったら気づく）", () => {
    const files = sources().map((s) => s.name).sort();
    expect(files).toEqual(["b64.rs", "http.rs", "json.rs", "lib.rs"]);
  });

  it("**HLLAPI の機能名が現れない**（意味づけを持ち込んでいない）", () => {
    const banned = [
      "CONNECT_PS", "DISCONNECT", "SEND_KEY", "COPY_PS", "SEARCH_PS",
      "QUERY_SESSION", "SET_CURSOR", "FIND_FIELD", "Presentation Space", "CP932", "Shift"
    ];
    for (const { name, code } of sources()) {
      for (const b of banned) {
        expect(code, `${name} に HLLAPI の意味づけ（${b}）がある`).not.toContain(b);
      }
    }
  });

  it("**機能番号で分岐していない**（分岐は TypeScript 側だけ）", () => {
    for (const { name, code } of sources()) {
      for (const pat of ["match function", "function ==", "*func ==", "match *func"]) {
        expect(code, `${name} が機能番号で分岐している（${pat}）`).not.toContain(pat);
      }
    }
  });

  it("**呼び出しをまたぐ状態を持たない**（状態は TypeScript 側）", () => {
    for (const { name, code } of sources()) {
      for (const pat of ["static mut", "OnceLock", "Mutex", "thread_local", "lazy_static"]) {
        expect(code, `${name} が状態を持っている（${pat}）`).not.toContain(pat);
      }
    }
  });

  it("**外部クレートがゼロ**（利用者が自分の環境でビルドできる）", () => {
    const toml = readFileSync(join(SRC, "..", "Cargo.toml"), "utf8");
    const deps = toml.split("[dependencies]")[1]?.split("[")[0] ?? "";
    const listed = deps
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l !== "" && !l.startsWith("#"));
    expect(listed, "外部クレートが増えている").toEqual([]);
  });

  it("**この層が持つ戻り値は 3 つだけ**（それ以外は TypeScript 側で決める）", () => {
    const lib = sources().find((s) => s.name === "lib.rs")!.code;
    const count = (lib.match(/const RC_/gu) ?? []).length;
    expect(count, "戻り値の定数が増えている。値を決めるのはサーバー側の仕事").toBe(3);
  });

  it("エントリポイントを 4 つとも出している（実装ごとに名前が違う）", () => {
    const lib = sources().find((s) => s.name === "lib.rs")!.code;
    for (const name of ["fn hllapi(", "fn HLLAPI(", "fn WinHLLAPI(", "fn hllc("]) {
      expect(lib, `${name} が無い`).toContain(name);
    }
  });
});
